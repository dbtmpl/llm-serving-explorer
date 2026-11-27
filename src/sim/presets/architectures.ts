/**
 * A trajectory of serving architectures, oldest first. Each one is the previous plus one idea,
 * expressed as parameter changes to the same simulation so the difference can be watched.
 * The prose (name, what it adds, where it comes from) is in src/content/architectures.md, by id.
 */
import type { CitationKey } from "../citations.js";
import type { Params } from "../core/params.js";

export interface Architecture {
  id: string;
  year: string;
  /** label for the dropdown */
  short: string;
  /** the sources behind this step, as keys into the citation registry */
  citations: readonly CitationKey[];
  params: Partial<Params>;
}

const VANILLA: Partial<Params> = {
  batching: "static",
  admission: "reserve",
  tokenBudget: 65536,
  prefixCaching: false,
  routing: "round-robin",
  routerReplicas: 1,
  syncIntervalS: 0,
  sharedPrefixTokens: 0,
  sharedPrefixGroups: 1,
  dramGB: 0,
  ssdGB: 0,
  remoteGB: 0,
  disagg: false,
  specDecode: false,
  overlap: false,
  shedAfterS: 0
};

export const ARCHITECTURES: Architecture[] = [
  {
    id: "static",
    year: "before 2022",
    short: "Static batching",
    citations: ["crankshaw2017", "tritonBatcher"],
    params: { ...VANILLA }
  },
  {
    id: "orca",
    year: "2022",
    short: "Continuous batching",
    citations: ["yu2022"],
    params: { ...VANILLA, batching: "continuous" }
  },
  {
    id: "paged",
    year: "2023",
    short: "PagedAttention",
    citations: ["kwon2023"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand" }
  },
  {
    id: "prefix",
    year: "2024",
    short: "Chunked prefill + prefix cache",
    citations: ["agrawal2024", "zheng2023", "vllmPrefixCaching", "llmdScheduling"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware" }
  },
  {
    id: "tiers",
    year: "2024–25",
    short: "Tiered KV cache",
    citations: ["gao2024", "qin2024", "lmcache2025", "dynamoKvbm", "llmdKvOffloader"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256 }
  },
  {
    id: "disagg",
    year: "2024–26",
    short: "Prefill/decode split",
    citations: ["zhong2024", "patel2023", "qin2024", "llmdDisaggregation"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256, disagg: true }
  },
  {
    id: "full",
    year: "2026",
    short: "Today's full stack",
    citations: ["leviathan2023", "llmdFlowControl"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256, disagg: true, specDecode: true, overlap: true, shedAfterS: 20 }
  },
  {
    id: "active-active",
    year: "2026",
    short: "Active-active routers (stale state)",
    citations: ["llmdIssue3440", "llmdPr4077", "mirrokni2018", "dahlin2000", "goren2020"],
    params: {
      ...VANILLA,
      minPods: 4,
      maxPods: 4,
      routerReplicas: 4,
      syncIntervalS: 0.2,
      sharedPrefixTokens: 1536,
      sharedPrefixGroups: 1,
      promptTokens: 2048,
      outputTokens: 128,
      routing: "prefix-aware",
      batching: "continuous",
      admission: "on-demand",
      tokenBudget: 8192,
      prefixCaching: true,
      dramGB: 0,
      ssdGB: 0,
      remoteGB: 0,
      disagg: false,
      specDecode: false,
      overlap: true
    }
  }
];

/** The architecture the default parameters correspond to. */
export const DEFAULT_ARCH = "tiers";
