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
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { POD_QUEUE_SLACK } from "../../src/sim/index.js";
import { CONFORMANCE_DIR, type Scenario } from "../scenario.js";
import { gpuNames, modelNames } from "./names.js";

/** GPUs per node in the simulated cluster. 8 is the usual HGX node; it only bounds how many replicas fit. */
export const GPUS_PER_NODE = 8;

/** vLLM's default `max_model_len` is the model's; BLIS needs one stated. Larger than any prompt in a scenario. */
export const MAX_MODEL_LEN = 131072;

/** The coefficient sets the llm-d example scenarios name (BLIS `examples/llm-d/scenarios/`). */
export const COEFFICIENT_SETS = ["cost-model-primitives", "cost-model-collectives", "cost-model-host-overheads", "cost-model-attention", "cost-model-recurrent", "cost-model-memory"];

/** Router configuration files, copied verbatim from the llm-d router fork BLIS pins (`blis router-configs --file`). */
export const EPP_FILES = { "prefix-aware": "default.yaml", "round-robin": "round-robin.yaml", "least-loaded": "least-active-requests.yaml" } as const;

export interface BlisInput {
  /** File name of the scenario inside the scenarios directory. */
  scenarioFile: string;
  /** Files to write: path relative to the working directory to contents. */
  files: Record<string, string>;
  /** Arguments of `blis replay`, with paths relative to the working directory. */
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

export function toBlis(s: Scenario): BlisInput {
  const model = modelNames(s.model).blis;
  const gpu = gpuNames(s.gpu).blis;
  const nodes = Math.max(1, Math.ceil((s.replicas * s.engine.tp) / GPUS_PER_NODE));
  const name = s.id;
  const eppFile = EPP_FILES[s.routing];
  const shipped = readFileSync(path.join(CONFORMANCE_DIR, "translate", "epp", eppFile), "utf8");
  // A queue deadline is the router's flow-control queue-wait budget (`flowControl.defaultRequestTTL`).
  // Flow control is a feature gate of the same configuration, so the shipped file is extended, not replaced.
  // Flow control only holds requests when a saturation detector says the pool is full, and the
  // router has none by default. The TypeScript router treats a replica as full at
  // `max_num_seqs + POD_QUEUE_SLACK` requests in flight; llm-d's concurrency detector with that
  // limit is the same rule, so the two routers gate at the same point. This is a translation
  // assumption, stated here and not tuned: the check below is about what is shed once held.
  const inFlightLimit = s.engine.maxNumSeqs + POD_QUEUE_SLACK;
  const flowControlled = (): string => {
    const doc = parse(shipped) as { plugins: unknown[] };
    return (
      `# ${eppFile} (shipped by the router) plus flow control: ${s.queueDeadlineS} s queue-wait budget, pool saturated at ${inFlightLimit} requests in flight per replica\n` +
      stringify({
        ...doc,
        plugins: [...doc.plugins, { type: "inflight-load-producer" }, { type: "concurrency-detector", parameters: { maxConcurrency: inFlightLimit } }],
        featureGates: ["flowControl"],
        flowControl: { defaultRequestTTL: `${s.queueDeadlineS}s`, saturationDetector: { pluginRef: "concurrency-detector" } }
      })
    );
  };
  const eppText = s.queueDeadlineS > 0 ? flowControlled() : shipped;

  const scenarioDoc =
    stringify({
      kind: "Scenario",
      name,
      engine: { kind: "vllm", version: "0.32.0" },
      model,
      coefficients: COEFFICIENT_SETS,
      cluster: { hardware: gpu, nodes, gpus_per_node: GPUS_PER_NODE }
    }) +
    "---\n" +
    stringify({
      kind: "Deployment",
      name,
      pools: [
        {
          role: "colocated",
          nodes,
          parallel: { tp: s.engine.tp, pp: 1, dp: 1, enable_expert_parallel: false },
          engine: {
            block_size: 16,
            max_num_batched_tokens: s.engine.maxNumBatchedTokens,
            max_num_seqs: s.engine.maxNumSeqs,
            max_model_len: s.engine.maxModelLen ?? MAX_MODEL_LEN,
            gpu_memory_utilization: s.engine.gpuMemoryUtilisation,
            enable_prefix_caching: s.engine.prefixCaching
          }
        }
      ],
      router: { endpoint_picker_config: `epp/${eppFile}` }
    });

  const header = stringify({ trace_version: 4, time_unit: "microseconds", mode: "generated", session_context_growth: "accumulate" });

  const rows = s.requests.map((r, i) => {
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
  const csv = [TRACE_COLUMNS.join(","), ...rows].join("\n") + "\n";

  const files: Record<string, string> = {
    [`scenarios/${name}.yaml`]: scenarioDoc,
    [`scenarios/epp/${eppFile}`]: eppText,
    "trace.yaml": header,
    "trace.csv": csv
  };
  const args = [
    "replay",
    "--trace-header", "trace.yaml",
    "--trace-data", "trace.csv",
    "--scenarios", "scenarios",
    "--scenario", `${name}.yaml`,
    "--session-mode", "fixed-accumulate",
    "--num-instances", String(s.replicas),
    "--output", "result.json"
  ];
  const hash = createHash("sha256");
  for (const k of Object.keys(files).sort()) hash.update(`${k}\0${files[k]}\0`);
  hash.update(args.join("\0"));
  return { scenarioFile: `${name}.yaml`, files, args, inputHash: hash.digest("hex") };
}
