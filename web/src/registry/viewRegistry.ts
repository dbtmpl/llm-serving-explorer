import type { ViewId } from "../state/urlState.js";

export interface ViewSlotDefinition {
  readonly id: ViewId;
  readonly label: string;
  readonly implemented: boolean;
  readonly description: string;
}

export const VIEW_REGISTRY: readonly ViewSlotDefinition[] = [
  {
    id: "gpu-map",
    label: "GPU & KV Cache",
    implemented: true,
    description: "Per-pod HBM memory anatomy and live paged KV cache block grid"
  },
  {
    id: "metrics",
    label: "Metrics",
    implemented: true,
    description: "Live cluster KPIs and interactive time-series charts"
  },
  {
    id: "event-log",
    label: "Event Log",
    implemented: true,
    description: "Filterable simulation event stream with click-to-seek and raw JSON inspection"
  },
  {
    id: "topology",
    label: "Topology",
    implemented: true,
    description: "Cluster gateway, pools, and live request flow diagram"
  },
  {
    id: "request-timeline",
    label: "Request Timeline",
    implemented: true,
    description: "Per-request lifecycle phase waterfall and TTFT/TPOT breakdown"
  },
  {
    id: "routing-explained",
    label: "Routing",
    implemented: true,
    description: "llm-d Endpoint Picker candidate score breakdown and regret"
  },
  {
    id: "tiers",
    label: "Memory Tiers",
    implemented: true,
    description: "GPU HBM <-> CPU DRAM offload and reload traffic"
  },
  {
    id: "pd-split",
    label: "P/D Split",
    implemented: true,
    description: "Prefill/Decode pool disaggregation and KV transfers"
  },
  {
    id: "multi-gpu",
    label: "Multi-GPU",
    implemented: true,
    description: "Tensor-parallel GPU sharding per pod"
  },
  {
    id: "roofline",
    label: "Roofline",
    implemented: true,
    description: "Batch arithmetic intensity vs compute and HBM ceilings"
  }
];
