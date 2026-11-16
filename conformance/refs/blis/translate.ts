/**
 * Neutral scenario to BLIS input: a Scenario + Deployment YAML, the llm-d router configuration, a
 * trace (header YAML and data CSV) and the command line that replays it.
 *
 * How a multi-turn conversation is expressed (verified against BLIS's `fixed_accumulate.go` and by
 * experiment): the header says `session_context_growth: accumulate`; a round's `input_tokens` is
 * then the tokens it ADDS, and BLIS rebuilds the absolute prompt as
 * `previous prompt + previous output + added tokens`, with identical token content in the shared
 * prefix. `--session-mode fixed-accumulate` injects every round at its recorded arrival time
 * (open loop), which is what the TypeScript trace workload does too.
 *
 * Two things `blis replay` cannot do, and what is used instead:
 *
 * - The autoscaler runs only in `blis run` ("blis replay does not support autoscaler config").
 *   An autoscaling scenario is therefore a `stream` (constant arrival rate, identical requests),
 *   written as a workload spec with the `constant` arrival process, whose arrivals fall at exactly
 *   i / rate: the same instants the TypeScript trace gets (`expandStream`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { POD_QUEUE_SLACK } from "../../src/sim/index.js";
import { AUTOSCALE_LOAD_S, CONFORMANCE_DIR, MAIN_ARM, type Deployment, type Scenario } from "../scenario.js";
import { GPU_MEMORY_GIB, gpuNames, modelNames } from "./names.js";

/** GPUs per node in the simulated cluster. 8 is the usual HGX node; it only bounds how many replicas fit. */
export const GPUS_PER_NODE = 8;

/** vLLM's default `max_model_len` is the model's; BLIS needs one stated. Larger than any prompt in a scenario. */
export const MAX_MODEL_LEN = 131072;

/** The coefficient sets the llm-d example scenarios name (BLIS `examples/llm-d/scenarios/`). */
export const COEFFICIENT_SETS = ["cost-model-primitives", "cost-model-collectives", "cost-model-host-overheads", "cost-model-attention", "cost-model-recurrent", "cost-model-memory"];

/** Priced transfers between pools, and to and from a host-memory tier, need their own coefficient sets. */
const FABRIC_SET = "cost-model-fabric";
const OFFLOAD_SET = "cost-model-offload-tiers";

/** The fabric between nodes when a handoff crosses them (400 Gbit/s InfiniBand, the one the llm-d example uses). */
export const FABRIC = "ib-400g";

/** Router configuration files, copied verbatim from the llm-d router fork BLIS pins (`blis router-configs --file`). */
export const EPP_FILES = { "prefix-aware": "default.yaml", "round-robin": "round-robin.yaml", "least-loaded": "least-active-requests.yaml" } as const;

/** The shipped prefill/decode configuration: a prefix-cache and queue scorer per pool, and a decider on uncached tokens. */
export const EPP_PD_FILE = "pd-prefix-based.yaml";

/** Every file name of `translate/epp/`; the reference script checks each against the binary. */
export const ALL_EPP_FILES: string[] = [...new Set<string>([...Object.values(EPP_FILES), EPP_PD_FILE])];

/** The autoscaler's tick, seconds. BLIS's saturation analyzer is told the stream's prompt length as its average input (it turns queue depth into token demand with it). */
export const AUTOSCALE_TICK_S = 1;

export interface BlisInput {
  /** File name of the scenario inside the scenarios directory. */
  scenarioFile: string;
  /** Files to write: path relative to the working directory to contents. */
  files: Record<string, string>;
  /** Arguments of the BLIS command, with paths relative to the working directory. */
  args: string[];
  /** SHA-256 of everything above: a reference made from other input is stale. */
  inputHash: string;
}

const TRACE_COLUMNS = [
  "request_id", "client_id", "tenant_id", "slo_class", "session_id", "round_index", "prefix_group", "prefix_length", "streaming",
  "input_tokens", "output_tokens", "text_tokens", "image_tokens", "audio_tokens", "video_tokens", "reason_ratio", "model",
  "deadline_us", "arrival_time_us", "first_chunk_time_us", "last_chunk_time_us", "status"
] as const;

/** Microseconds in a second: BLIS's trace time unit is microseconds. */
const US_PER_S = 1e6;

export const blisSessionId = (session: number): string => `s${session}`;

/** Gigabytes of the scenario (1e9 bytes, as the TypeScript model counts them) to bytes. */
const BYTES_PER_GB = 1e9;

function engineBlock(d: Deployment): Record<string, unknown> {
  return {
    block_size: 16,
    max_num_batched_tokens: d.engine.maxNumBatchedTokens,
    max_num_seqs: d.engine.maxNumSeqs,
    max_model_len: d.engine.maxModelLen ?? MAX_MODEL_LEN,
    gpu_memory_utilization: d.engine.gpuMemoryUtilisation,
    enable_prefix_caching: d.engine.prefixCaching,
    // n-gram: the one drafter BLIS builds that needs no draft model in its catalogue, and the one it does not price (its passes cost nothing)
    ...(d.speculative ? { speculative_config: { method: "ngram", num_speculative_tokens: d.speculative.k } } : {})
  };
}

export function toBlis(s: Scenario, arm: string = MAIN_ARM): BlisInput {
  const d = s.arms[arm];
  if (!d) throw new Error(`${s.id}: no arm "${arm}"`);
  const model = modelNames(d.model).blis;
  const gpu = gpuNames(d.gpu).blis;
  const name = `${s.id}${arm === MAIN_ARM ? "" : `-${arm}`}`;
  const perPoolNodes = (replicas: number): number => Math.max(1, Math.ceil((replicas * d.engine.tp) / GPUS_PER_NODE));
  const pools = d.disagg
    ? [
        { role: "prefill", replicas: d.disagg.prefillReplicas },
        { role: "decode", replicas: d.disagg.decodeReplicas }
      ]
    : [{ role: "colocated", replicas: d.replicas }];
  const nodes = pools.reduce((n, p) => n + perPoolNodes(d.autoscale ? d.autoscale.maxReplicas : p.replicas), 0);
  const eppFile = d.disagg ? EPP_PD_FILE : EPP_FILES[d.routing];
  const shipped = readFileSync(path.join(CONFORMANCE_DIR, "translate", "epp", eppFile), "utf8");

  // A queue deadline is the router's flow-control queue-wait budget (`flowControl.defaultRequestTTL`).
  // Flow control is a feature gate of the same configuration, so the shipped file is extended, not replaced.
  // Flow control only holds requests when a saturation detector says the pool is full, and the
  // router has none by default. The TypeScript router treats a replica as full at
  // `max_num_seqs + POD_QUEUE_SLACK` requests in flight; llm-d's concurrency detector with that
  // limit is the same rule, so the two routers gate at the same point. This is a translation
  // assumption, stated here and not tuned: the check below is about what is shed once held.
  const inFlightLimit = d.engine.maxNumSeqs + POD_QUEUE_SLACK;
  const flowControlled = (): string => {
    const doc = parse(shipped) as { plugins: unknown[] };
    return (
      `# ${eppFile} (shipped by the router) plus flow control: ${d.queueDeadlineS} s queue-wait budget, pool saturated at ${inFlightLimit} requests in flight per replica\n` +
      stringify({
        ...doc,
        plugins: [...doc.plugins, { type: "inflight-load-producer" }, { type: "concurrency-detector", parameters: { maxConcurrency: inFlightLimit } }],
        featureGates: ["flowControl"],
        flowControl: { defaultRequestTTL: `${d.queueDeadlineS}s`, saturationDetector: { pluginRef: "concurrency-detector" } }
      })
    );
  };
  // The prefill/decode decider is "send to the prefill pool when more than `nonCachedTokens` prompt tokens are uncached
  // on the chosen decode replica"; the shipped file says 16, the scenario states its own threshold.
  const pdThresholded = (): string => `# ${eppFile} (shipped by the router) with nonCachedTokens set to the scenario's threshold\n${shipped.replace(/nonCachedTokens: \d+/, `nonCachedTokens: ${d.disagg!.thresholdTokens}`)}`;
  const eppText = d.disagg ? pdThresholded() : d.queueDeadlineS > 0 ? flowControlled() : shipped;

  const coefficients = [...COEFFICIENT_SETS, ...(d.disagg ? [FABRIC_SET] : []), ...(d.offload ? [OFFLOAD_SET] : [])];
  const scenarioDoc =
    stringify({
      kind: "Scenario",
      name,
      engine: { kind: "vllm", version: "0.32.0" },
      model,
      coefficients,
      cluster: { hardware: gpu, ...(d.disagg ? { fabric: FABRIC } : {}), nodes, gpus_per_node: GPUS_PER_NODE }
    }) +
    "---\n" +
    stringify({
      kind: "Deployment",
      name,
      pools: pools.map((p) => ({
        role: p.role,
        nodes: perPoolNodes(d.autoscale ? d.autoscale.maxReplicas : p.replicas),
        parallel: { tp: d.engine.tp, pp: 1, dp: 1, enable_expert_parallel: false },
        engine: engineBlock(d)
      })),
      // an offload tier needs a MultiConnector around NIXL under prefill/decode (BLIS docs, "Prefill/decode disaggregation")
      ...(d.offload ? { offload: { connector: "OffloadingConnector", spec: "TieringOffloadingSpec", eviction_policy: "lru", tiers: [{ tier: "cpu_dram", bytes: Math.round(d.offload.cpuGB * BYTES_PER_GB) }] } } : {}),
      ...(d.disagg ? { pd_transfer: { connector: d.offload ? "MultiConnector" : "NixlConnector" } } : {}),
      router: { endpoint_picker_config: `epp/${eppFile}` }
    });

  const files: Record<string, string> = {
    [`scenarios/${name}.yaml`]: scenarioDoc,
    [`scenarios/epp/${eppFile}`]: eppText
  };
  let args: string[];
  if (d.stream) {
    // `blis run` with a constant-rate workload spec: the same requests, at the same instants, as `expandStream`
    files["workload.yaml"] = stringify({
      version: "2",
      seed: 1,
      aggregate_rate: d.stream.ratePerS,
      num_requests: d.stream.count,
      clients: [
        {
          id: "c",
          rate_fraction: 1.0,
          arrival: { process: "constant" },
          input_distribution: { type: "constant", params: { value: d.stream.promptTokens } },
          output_distribution: { type: "constant", params: { value: d.stream.outputTokens } }
        }
      ]
    });
    args = ["run", "--scenarios", "scenarios", "--scenario", `${name}.yaml`, "--workload-spec", "workload.yaml", "--num-instances", String(d.autoscale ? d.autoscale.minReplicas : d.replicas), "--output", "result.json"];
    if (d.autoscale) {
      files["policy.yaml"] = stringify({
        autoscaler: { interval_us: AUTOSCALE_TICK_S * US_PER_S, scale_up_stabilization_window_us: 0, scale_down_stabilization_window_us: 0, analyzer: { min_replicas: d.autoscale.minReplicas, avg_input_tokens: d.stream.promptTokens } },
        // the autoscaler places new replicas on a node pool: one node of the scenario's GPU holds every replica the scenario allows
        node_pools: [{ name: "pool", gpu_type: gpu, gpus_per_node: GPUS_PER_NODE, gpu_memory_gib: GPU_MEMORY_GIB[gpu], initial_nodes: nodes, min_nodes: nodes, max_nodes: nodes }],
        instance_lifecycle: { loading_delay: { mean: AUTOSCALE_LOAD_S, stddev: 0 }, warm_start_initial_instances: true }
      });
      args.push("--policy-config", "policy.yaml");
    }
  } else {
    // A trace written as "generated" carries the deployment it was made with and refuses a host-memory tier on replay; "converted" takes it from the scenario
    files["trace.yaml"] = stringify({ trace_version: 4, time_unit: "microseconds", mode: d.offload ? "converted" : "generated", session_context_growth: "accumulate" });
    const rows = d.requests.map((r, i) => {
      const cells: Record<(typeof TRACE_COLUMNS)[number], string | number> = {
        request_id: i,
        client_id: "c",
        tenant_id: "t",
        slo_class: "standard",
        session_id: blisSessionId(r.session),
        round_index: r.round,
        prefix_group: "",
        prefix_length: 0,
        streaming: "false",
        input_tokens: r.newTokens,
        output_tokens: r.outputTokens,
        text_tokens: r.newTokens,
        image_tokens: 0,
        audio_tokens: 0,
        video_tokens: 0,
        reason_ratio: "0.0",
        model: "",
        deadline_us: 0,
        arrival_time_us: Math.round(r.at * US_PER_S),
        first_chunk_time_us: 0,
        last_chunk_time_us: 0,
        status: "ok"
      };
      return TRACE_COLUMNS.map((c) => cells[c]).join(",");
    });
    files["trace.csv"] = [TRACE_COLUMNS.join(","), ...rows].join("\n") + "\n";
    args = ["replay", "--trace-header", "trace.yaml", "--trace-data", "trace.csv", "--scenarios", "scenarios", "--scenario", `${name}.yaml`, "--session-mode", "fixed-accumulate", "--num-instances", String(d.replicas), "--output", "result.json"];
  }
  if (d.disagg) args.push("--prefill-instances", String(d.disagg.prefillReplicas), "--decode-instances", String(d.disagg.decodeReplicas));
  // BLIS takes the mean tokens per verification step as its input; this is the same number the TypeScript translator turns into a per-token probability
  if (d.speculative) args.push("--speculative-acceptance-length", String(d.speculative.acceptanceLength));

  const hash = createHash("sha256");
  for (const k of Object.keys(files).sort()) hash.update(`${k}\0${files[k]}\0`);
  hash.update(args.join("\0"));
  return { scenarioFile: `${name}.yaml`, files, args, inputHash: hash.digest("hex") };
}

/** One hash for all arms of a scenario. */
export function scenarioInputHash(s: Scenario): string {
  const names = Object.keys(s.arms);
  if (names.length === 1 && names[0] === MAIN_ARM) return toBlis(s, MAIN_ARM).inputHash;
  const h = createHash("sha256");
  for (const a of names) h.update(`${a}\0${toBlis(s, a).inputHash}\0`);
  return h.digest("hex");
}
