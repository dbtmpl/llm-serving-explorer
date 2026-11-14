export type PresetId =
  | "llama-3.1-8b-instruct"
  | "llama-3.1-70b-instruct"
  | "llama-3.1-8b-a100"
  | "llama-3.1-70b-h100";

export type CanonicalPresetId = "llama-3.1-8b-instruct" | "llama-3.1-70b-instruct";

export type RoutingPolicy = "round-robin" | "prefix-cache" | "least-loaded";

export interface InjectedRequestConfig {
  id?: string;
  arrival_s: number;
  prompt_tokens: number;
  output_tokens: number;
  prefix_group?: string;
}

export interface SimulationRunConfig {
  preset?: PresetId;
  num_requests?: number;
  rate?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  prefix_tokens?: number;
  max_num_seqs?: number;
  gpu_memory_utilization?: number;
  routing_policy?: RoutingPolicy;
  num_instances?: number;
  prefill_instances?: number;
  decode_instances?: number;
  offload_cpu_gib?: number;
  seed?: number;
  horizon_us?: number;
  injected_request?: InjectedRequestConfig;
}

export interface PresetSpec {
  readonly id: CanonicalPresetId;
  readonly label: string;
  readonly model: string;
  readonly hardware: string;
  readonly tp: number;
  readonly blockSize: number;
  readonly maxModelLen: number;
  readonly quantization?: string;
  readonly kvCacheDtype?: string;
}

export const PRESET_SPECS: Readonly<Record<CanonicalPresetId, PresetSpec>> = {
  "llama-3.1-8b-instruct": {
    id: "llama-3.1-8b-instruct",
    label: "Llama 3.1 8B · A100 80GB (closest calibrated A100; 40GB not in BLIS catalog)",
    model: "llama-3.1-8b-instruct",
    hardware: "a100-sxm",
    tp: 1,
    blockSize: 16,
    maxModelLen: 8192
  },
  "llama-3.1-70b-instruct": {
    id: "llama-3.1-70b-instruct",
    label: "Llama 3.1 70B (FP8, TP=2) · H100 80GB",
    model: "llama-3.1-70b-instruct",
    hardware: "h100",
    tp: 2,
    blockSize: 16,
    maxModelLen: 8192,
    quantization: "fp8",
    kvCacheDtype: "fp8"
  }
};

export function resolvePresetSpec(preset?: PresetId): PresetSpec {
  if (!preset || preset === "llama-3.1-8b-instruct" || preset === "llama-3.1-8b-a100") {
    return PRESET_SPECS["llama-3.1-8b-instruct"];
  }
  if (preset === "llama-3.1-70b-instruct" || preset === "llama-3.1-70b-h100") {
    return PRESET_SPECS["llama-3.1-70b-instruct"];
  }
  throw new Error(`Unsupported preset: ${String(preset)}`);
}

export interface ConfigPathOptions {
  scenarioDir: string;
  defaultsFilepath: string;
  eventsOutputPath: string;
  scenarioFilename?: string;
  workloadSpecPath?: string;
}

export interface InjectedRequestMetadata {
  tag: string;
  arrivalUs: number;
  promptTokens: number;
  outputTokens: number;
  prefixTokens: number;
  totalPromptTokens: number;
  prefixGroup?: string;
}

export interface BuiltSimulationConfig {
  scenarioYaml: string;
  routerYaml: string;
  workloadYaml?: string;
  commandArgs: string[];
  normalized: {
    preset: CanonicalPresetId;
    num_requests: number;
    rate: number;
    prompt_tokens: number;
    output_tokens: number;
    prefix_tokens: number;
    max_num_seqs?: number;
    gpu_memory_utilization?: number;
    routing_policy: RoutingPolicy;
    num_instances: number;
    prefill_instances: number;
    decode_instances: number;
    offload_cpu_gib: number;
    seed: number;
    horizon_us?: number;
  };
  disaggregated: boolean;
  expectedTotalRequests: number;
  injectedRequest?: InjectedRequestMetadata;
}

const GPUS_PER_NODE = 8;
const BASE_COEFFICIENTS = [
  "cost-model-primitives",
  "cost-model-collectives",
  "cost-model-host-overheads",
  "cost-model-attention",
  "cost-model-recurrent",
  "cost-model-memory"
];

function assertPositiveInt(name: string, val: unknown): number {
  if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
    throw new Error(`${name} must be an integer >= 1 (got ${String(val)})`);
  }
  return val;
}

function assertNonNegativeInt(name: string, val: unknown): number {
  if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
    throw new Error(`${name} must be an integer >= 0 (got ${String(val)})`);
  }
  return val;
}

function assertPositiveFinite(name: string, val: unknown): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
    throw new Error(`${name} must be a positive finite number (got ${String(val)})`);
  }
  return val;
}

function assertNonNegativeFinite(name: string, val: unknown): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(`${name} must be a non-negative finite number (got ${String(val)})`);
  }
  return val;
}

function sanitizeYamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Generates an EndpointPickerConfig YAML for the requested routing policy and topology.
 */
export function buildRouterYaml(policy: RoutingPolicy, disaggregated: boolean): string {
  if (!disaggregated) {
    if (policy === "round-robin") {
      return [
        "apiVersion: llm-d.ai/v1",
        "kind: EndpointPickerConfig",
        "plugins:",
        "- type: single-profile-handler",
        "- type: random-picker",
        "schedulingProfiles:",
        "- name: default",
        "  plugins:",
        "  - pluginRef: random-picker",
        ""
      ].join("\n");
    }

    if (policy === "prefix-cache") {
      return [
        "apiVersion: llm-d.ai/v1",
        "kind: EndpointPickerConfig",
        "plugins:",
        "- type: single-profile-handler",
        "- type: approx-prefix-cache-producer",
        "- type: prefix-cache-scorer",
        "- type: queue-scorer",
        "- type: kv-cache-utilization-scorer",
        "- type: max-score-picker",
        "schedulingProfiles:",
        "- name: default",
        "  plugins:",
        "  - pluginRef: prefix-cache-scorer",
        "    weight: 3",
        "  - pluginRef: queue-scorer",
        "    weight: 1",
        "  - pluginRef: kv-cache-utilization-scorer",
        "    weight: 1",
        "  - pluginRef: max-score-picker",
        ""
      ].join("\n");
    }

    // least-loaded
    return [
      "apiVersion: llm-d.ai/v1",
      "kind: EndpointPickerConfig",
      "plugins:",
      "- type: single-profile-handler",
      "- type: queue-scorer",
      "- type: kv-cache-utilization-scorer",
      "- type: max-score-picker",
      "schedulingProfiles:",
      "- name: default",
      "  plugins:",
      "  - pluginRef: queue-scorer",
      "    weight: 2",
      "  - pluginRef: kv-cache-utilization-scorer",
      "    weight: 1",
      "  - pluginRef: max-score-picker",
      ""
    ].join("\n");
  }

  // Disaggregated prefill/decode router configuration
  const extraPlugins: string[] = [];
  const profilePlugins: string[] = [];

  if (policy === "round-robin") {
    extraPlugins.push("- type: random-picker");
    profilePlugins.push("  - pluginRef: random-picker");
  } else if (policy === "prefix-cache") {
    extraPlugins.push(
      "- type: approx-prefix-cache-producer",
      "  parameters:",
      "    maxPrefixTokensToMatch: 16384",
      "    lruCapacityPerServer: 31250",
      "- type: prefix-cache-scorer",
      "- type: queue-scorer",
      "- type: kv-cache-utilization-scorer",
      "- type: max-score-picker"
    );
    profilePlugins.push(
      "  - pluginRef: max-score-picker",
      "  - pluginRef: prefix-cache-scorer",
      "    weight: 3",
      "  - pluginRef: queue-scorer",
      "    weight: 1",
      "  - pluginRef: kv-cache-utilization-scorer",
      "    weight: 1"
    );
  } else {
    extraPlugins.push(
      "- type: queue-scorer",
      "- type: kv-cache-utilization-scorer",
      "- type: max-score-picker"
    );
    profilePlugins.push(
      "  - pluginRef: max-score-picker",
      "  - pluginRef: queue-scorer",
      "    weight: 2",
      "  - pluginRef: kv-cache-utilization-scorer",
      "    weight: 1"
    );
  }

  return [
    "apiVersion: llm-d.ai/v1",
    "kind: EndpointPickerConfig",
    "plugins:",
    ...extraPlugins,
    "- type: prefill-filter",
    "- type: decode-filter",
    "- type: always-disagg-pd-decider",
    "- type: disagg-profile-handler",
    "  parameters:",
    "    deciders:",
    "      prefill: always-disagg-pd-decider",
    "schedulingProfiles:",
    "- name: prefill",
    "  plugins:",
    "  - pluginRef: prefill-filter",
    ...profilePlugins,
    "- name: decode",
    "  plugins:",
    "  - pluginRef: decode-filter",
    ...profilePlugins,
    ""
  ].join("\n");
}

function buildPoolEngineYaml(
  preset: PresetSpec,
  maxNumSeqs?: number,
  gpuMemUtil?: number
): string[] {
  const lines: string[] = ["    engine:"];
  if (preset.quantization) {
    lines.push(`      quantization: ${preset.quantization}`);
  }
  if (preset.kvCacheDtype) {
    lines.push(`      kv_cache_dtype: ${preset.kvCacheDtype}`);
  }
  lines.push(`      block_size: ${preset.blockSize}`);
  lines.push(`      max_model_len: ${preset.maxModelLen}`);
  if (maxNumSeqs !== undefined) {
    lines.push(`      max_num_seqs: ${maxNumSeqs}`);
  }
  if (gpuMemUtil !== undefined) {
    lines.push(`      gpu_memory_utilization: ${gpuMemUtil}`);
  }
  return lines;
}

function buildPoolBlockYaml(
  role: "colocated" | "prefill" | "decode",
  nodes: number,
  preset: PresetSpec,
  maxNumSeqs?: number,
  gpuMemUtil?: number
): string[] {
  return [
    `  - role: ${role}`,
    `    nodes: ${nodes}`,
    "    parallel:",
    `      tp: ${preset.tp}`,
    "      pp: 1",
    "      dp: 1",
    "      enable_expert_parallel: false",
    ...buildPoolEngineYaml(preset, maxNumSeqs, gpuMemUtil)
  ];
}

function buildWorkloadYamlWithInjection(params: {
  seed: number;
  numRequests: number;
  rate: number;
  promptTokens: number;
  outputTokens: number;
  prefixTokens: number;
  injected: InjectedRequestConfig;
}): { yaml: string; meta: InjectedRequestMetadata } {
  const { seed, numRequests, rate, promptTokens, outputTokens, prefixTokens, injected } = params;

  const arrivalUs = Math.max(1, Math.round(injected.arrival_s * 1_000_000));
  const iat0 = Math.max(1, Math.floor(1_000_000 / rate));
  // Offset by +0.5 µs so int64(1.0 / (rate / 1e6)) never truncates below the integer µs target.
  const r0 = 1_000_000 / (iat0 + 0.5);
  const r1 = 1_000_000 / (arrivalUs + 0.5);
  const aggregateRate = r0 + r1;

  const bgEndUs = numRequests * iat0 + 1;
  const injWindows =
    arrivalUs === 1
      ? [{ start_us: 1, end_us: 2 }]
      : [
          { start_us: 0, end_us: 1 },
          { start_us: arrivalUs, end_us: arrivalUs + 2 }
        ];

  const bgLines: string[] = [
    '  - id: "background"',
    `    rate_fraction: ${r0}`,
    "    arrival: { process: constant }",
    `    input_distribution: { type: constant, params: { value: ${promptTokens} } }`,
    `    output_distribution: { type: constant, params: { value: ${outputTokens} } }`,
    "    lifecycle:",
    "      windows:",
    `        - { start_us: 0, end_us: ${bgEndUs} }`
  ];
  if (prefixTokens > 0) {
    bgLines.splice(
      2,
      0,
      '    prefix_group: "shared"',
      `    prefix_length: ${prefixTokens}`
    );
  }

  const rawPrefixGroup = injected.prefix_group?.trim();
  // BLIS defaults prefix_length to 50 if prefix_group is set without prefix_length > 0.
  // Only attach prefix_group/prefix_length when prefix_tokens > 0 so prompt token counts stay exact.
  const effectivePrefixGroup = prefixTokens > 0 && rawPrefixGroup ? rawPrefixGroup : undefined;
  const effectivePrefixTokens = effectivePrefixGroup ? prefixTokens : 0;

  const injLines: string[] = [
    '  - id: "injected"',
    `    rate_fraction: ${r1}`,
    "    arrival: { process: constant }",
    `    input_distribution: { type: constant, params: { value: ${injected.prompt_tokens} } }`,
    `    output_distribution: { type: constant, params: { value: ${injected.output_tokens} } }`,
    "    lifecycle:",
    "      windows:"
  ];
  for (const w of injWindows) {
    injLines.push(`        - { start_us: ${w.start_us}, end_us: ${w.end_us} }`);
  }
  if (effectivePrefixGroup) {
    injLines.splice(
      2,
      0,
      `    prefix_group: ${sanitizeYamlString(effectivePrefixGroup)}`,
      `    prefix_length: ${effectivePrefixTokens}`
    );
  }

  const yaml = [
    'version: "2"',
    `seed: ${seed}`,
    "category: language",
    `aggregate_rate: ${aggregateRate}`,
    `num_requests: ${numRequests + 1}`,
    "clients:",
    ...bgLines,
    ...injLines,
    ""
  ].join("\n");

  return {
    yaml,
    meta: {
      tag: injected.id?.trim() || "injected",
      arrivalUs,
      promptTokens: injected.prompt_tokens,
      outputTokens: injected.output_tokens,
      prefixTokens: effectivePrefixTokens,
      totalPromptTokens: injected.prompt_tokens + effectivePrefixTokens,
      prefixGroup: effectivePrefixGroup
    }
  };
}

/**
 * Builds BLIS scenario.yaml, router.yaml, optional workload.yaml (for single-request injection),
 * and the exact `blis run` CLI arguments shared by both `local-runner` and the browser WASM worker.
 */
export function buildSimulationConfig(
  input: SimulationRunConfig,
  paths: ConfigPathOptions
): BuiltSimulationConfig {
  const preset = resolvePresetSpec(input.preset);
  const numRequests =
    input.num_requests !== undefined ? assertPositiveInt("num_requests", input.num_requests) : 16;
  const rate = input.rate !== undefined ? assertPositiveFinite("rate", input.rate) : 4;
  const promptTokens =
    input.prompt_tokens !== undefined ? assertPositiveInt("prompt_tokens", input.prompt_tokens) : 64;
  const outputTokens =
    input.output_tokens !== undefined ? assertPositiveInt("output_tokens", input.output_tokens) : 32;
  const prefixTokens =
    input.prefix_tokens !== undefined
      ? assertNonNegativeInt("prefix_tokens", input.prefix_tokens)
      : 0;
  const maxNumSeqs =
    input.max_num_seqs !== undefined ? assertPositiveInt("max_num_seqs", input.max_num_seqs) : undefined;

  let gpuMemUtil: number | undefined;
  if (input.gpu_memory_utilization !== undefined) {
    if (
      typeof input.gpu_memory_utilization !== "number" ||
      !Number.isFinite(input.gpu_memory_utilization) ||
      input.gpu_memory_utilization <= 0 ||
      input.gpu_memory_utilization > 1
    ) {
      throw new Error(
        `gpu_memory_utilization must be in (0, 1] (got ${String(input.gpu_memory_utilization)})`
      );
    }
    gpuMemUtil = input.gpu_memory_utilization;
  }

  const routingPolicy: RoutingPolicy = input.routing_policy ?? "least-loaded";
  if (
    routingPolicy !== "round-robin" &&
    routingPolicy !== "prefix-cache" &&
    routingPolicy !== "least-loaded"
  ) {
    throw new Error(`Unsupported routing_policy: ${String(routingPolicy)}`);
  }

  const prefillInstances =
    input.prefill_instances !== undefined
      ? assertNonNegativeInt("prefill_instances", input.prefill_instances)
      : 0;
  const decodeInstances =
    input.decode_instances !== undefined
      ? assertNonNegativeInt("decode_instances", input.decode_instances)
      : 0;

  if ((prefillInstances > 0) !== (decodeInstances > 0)) {
    throw new Error(
      "Both prefill_instances and decode_instances must be > 0 for P/D disaggregation"
    );
  }

  const disaggregated = prefillInstances > 0 && decodeInstances > 0;
  const numInstances =
    input.num_instances !== undefined
      ? assertPositiveInt("num_instances", input.num_instances)
      : disaggregated
        ? prefillInstances + decodeInstances
        : 1;

  if (disaggregated && numInstances !== prefillInstances + decodeInstances) {
    throw new Error(
      `When P/D disaggregation is enabled, num_instances (${numInstances}) must equal prefill_instances + decode_instances (${prefillInstances + decodeInstances})`
    );
  }

  const offloadCpuGib =
    input.offload_cpu_gib !== undefined
      ? assertNonNegativeFinite("offload_cpu_gib", input.offload_cpu_gib)
      : 0;

  const seed =
    input.seed !== undefined
      ? (() => {
          if (typeof input.seed !== "number" || !Number.isInteger(input.seed)) {
            throw new Error(`seed must be an integer (got ${String(input.seed)})`);
          }
          return input.seed;
        })()
      : 42;

  const horizonUs =
    input.horizon_us !== undefined ? assertPositiveInt("horizon_us", input.horizon_us) : undefined;

  let injected: InjectedRequestConfig | undefined;
  if (input.injected_request) {
    const req = input.injected_request;
    assertNonNegativeFinite("injected_request.arrival_s", req.arrival_s);
    assertPositiveInt("injected_request.prompt_tokens", req.prompt_tokens);
    assertPositiveInt("injected_request.output_tokens", req.output_tokens);
    injected = req;
  }

  const coefficients = [...BASE_COEFFICIENTS];
  if (offloadCpuGib > 0) {
    coefficients.push("cost-model-offload-tiers");
  }
  if (disaggregated) {
    coefficients.push("cost-model-fabric");
  }

  const prefillNodes = disaggregated
    ? Math.max(1, Math.ceil((prefillInstances * preset.tp) / GPUS_PER_NODE))
    : 0;
  const decodeNodes = disaggregated
    ? Math.max(1, Math.ceil((decodeInstances * preset.tp) / GPUS_PER_NODE))
    : 0;
  const colocatedNodes = disaggregated
    ? 0
    : Math.max(1, Math.ceil((numInstances * preset.tp) / GPUS_PER_NODE));
  const totalNodes = disaggregated ? prefillNodes + decodeNodes : colocatedNodes;

  const scenarioName = `custom-${preset.id}`;
  const scenarioLines: string[] = [
    "kind: Scenario",
    `name: ${scenarioName}`,
    "engine:",
    "  kind: vllm",
    '  version: "0.32.0"',
    "",
    `model: ${preset.model}`,
    `coefficients: [${coefficients.join(", ")}]`,
    "",
    "cluster:",
    `  hardware: ${preset.hardware}`
  ];
  if (disaggregated) {
    scenarioLines.push("  fabric: ib-400g");
  }
  scenarioLines.push(
    `  nodes: ${totalNodes}`,
    `  gpus_per_node: ${GPUS_PER_NODE}`,
    "---",
    "kind: Deployment",
    `name: ${scenarioName}`,
    "",
    "pools:"
  );

  if (disaggregated) {
    scenarioLines.push(
      ...buildPoolBlockYaml("prefill", prefillNodes, preset, maxNumSeqs, gpuMemUtil),
      ...buildPoolBlockYaml("decode", decodeNodes, preset, maxNumSeqs, gpuMemUtil),
      "",
      "pd_transfer:",
      "  connector: NixlConnector"
    );
  } else {
    scenarioLines.push(
      ...buildPoolBlockYaml("colocated", colocatedNodes, preset, maxNumSeqs, gpuMemUtil)
    );
  }

  if (offloadCpuGib > 0) {
    const bytes = Math.max(1, Math.round(offloadCpuGib * 1024 * 1024 * 1024));
    scenarioLines.push(
      "",
      "offload:",
      "  connector: OffloadingConnector",
      "  spec: TieringOffloadingSpec",
      "  eviction_policy: lru",
      "  tiers:",
      "    - tier: cpu_dram",
      `      bytes: ${bytes}`
    );
  }

  scenarioLines.push("", "router:", "  endpoint_picker_config: router.yaml", "");

  const scenarioYaml = scenarioLines.join("\n");
  const routerYaml = buildRouterYaml(routingPolicy, disaggregated);

  const scenarioFilename = paths.scenarioFilename ?? "scenario.yaml";
  const commandArgs: string[] = [
    "run",
    "--scenarios",
    paths.scenarioDir,
    "--scenario",
    scenarioFilename,
    "--defaults-filepath",
    paths.defaultsFilepath,
    "--events-output",
    paths.eventsOutputPath,
    "--num-instances",
    String(numInstances),
    "--seed",
    String(seed),
    "--timeout",
    "-1"
  ];

  if (disaggregated) {
    commandArgs.push(
      "--prefill-instances",
      String(prefillInstances),
      "--decode-instances",
      String(decodeInstances)
    );
  }

  if (horizonUs !== undefined) {
    commandArgs.push("--horizon", String(horizonUs));
  }

  let workloadYaml: string | undefined;
  let injectedRequest: InjectedRequestMetadata | undefined;

  if (injected) {
    if (!paths.workloadSpecPath) {
      throw new Error("paths.workloadSpecPath is required when injected_request is provided");
    }
    const builtWorkload = buildWorkloadYamlWithInjection({
      seed,
      numRequests,
      rate,
      promptTokens,
      outputTokens,
      prefixTokens,
      injected
    });
    workloadYaml = builtWorkload.yaml;
    injectedRequest = builtWorkload.meta;
    commandArgs.push("--workload-spec", paths.workloadSpecPath);
  } else {
    commandArgs.push(
      "--num-requests",
      String(numRequests),
      "--rate",
      String(rate),
      "--prompt-tokens",
      String(promptTokens),
      "--prompt-tokens-stdev",
      "0",
      "--prompt-tokens-min",
      String(promptTokens),
      "--prompt-tokens-max",
      String(promptTokens),
      "--output-tokens",
      String(outputTokens),
      "--output-tokens-stdev",
      "0",
      "--output-tokens-min",
      String(outputTokens),
      "--output-tokens-max",
      String(outputTokens),
      "--prefix-tokens",
      String(prefixTokens)
    );
  }

  return {
    scenarioYaml,
    routerYaml,
    workloadYaml,
    commandArgs,
    normalized: {
      preset: preset.id,
      num_requests: numRequests,
      rate,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      prefix_tokens: prefixTokens,
      max_num_seqs: maxNumSeqs,
      gpu_memory_utilization: gpuMemUtil,
      routing_policy: routingPolicy,
      num_instances: numInstances,
      prefill_instances: prefillInstances,
      decode_instances: decodeInstances,
      offload_cpu_gib: offloadCpuGib,
      seed,
      horizon_us: horizonUs
    },
    disaggregated,
    expectedTotalRequests: injected ? numRequests + 1 : numRequests,
    injectedRequest
  };
}

/**
 * Finds the BLIS-assigned request ID (`request_k`) of the injected request inside an NDJSON stream.
 */
export function findInjectedRequestId(
  ndjson: string,
  meta?: InjectedRequestMetadata
): string | undefined {
  if (!meta) {
    return undefined;
  }
  let bestCandidate: string | undefined;
  const lines = ndjson.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "request.arrived") continue;
    if (
      rec.t_us === meta.arrivalUs &&
      rec.prompt_tokens === meta.totalPromptTokens &&
      rec.max_output_tokens === meta.outputTokens &&
      (meta.prefixGroup === undefined || rec.prefix_group === meta.prefixGroup)
    ) {
      return typeof rec.req_id === "string" ? rec.req_id : undefined;
    }
    if (
      !bestCandidate &&
      rec.t_us === meta.arrivalUs &&
      rec.max_output_tokens === meta.outputTokens
    ) {
      bestCandidate = typeof rec.req_id === "string" ? rec.req_id : undefined;
    }
  }
  return bestCandidate;
}
