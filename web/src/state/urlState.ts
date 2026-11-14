export type AppMode = "guided" | "compare" | "custom" | "accuracy";

export type ViewId =
  | "gpu-map"
  | "metrics"
  | "event-log"
  | "topology"
  | "request-timeline"
  | "routing-explained"
  | "tiers"
  | "pd-split"
  | "multi-gpu"
  | "roofline";

export interface UrlAppState {
  readonly scenario: string;
  readonly t: number;
  readonly speed: number;
  readonly view: ViewId;
  readonly mode: AppMode;
  readonly compare?: string;
  readonly req?: string;
  readonly pod?: string;
}

export const DEFAULT_SCENARIO_ID = "01-single-request";
export const DEFAULT_VIEW_ID: ViewId = "gpu-map";
export const DEFAULT_MODE: AppMode = "guided";
export const DEFAULT_SPEED = 1;

const VALID_MODES = new Set<AppMode>(["guided", "compare", "custom", "accuracy"]);
const VALID_VIEWS = new Set<ViewId>([
  "gpu-map",
  "metrics",
  "event-log",
  "topology",
  "request-timeline",
  "routing-explained",
  "tiers",
  "pd-split",
  "multi-gpu",
  "roofline"
]);

export function parseUrlState(search: string): UrlAppState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  const rawScenario = params.get("scenario")?.trim();
  const scenario = rawScenario && rawScenario.length > 0 ? rawScenario : DEFAULT_SCENARIO_ID;

  const rawT = Number(params.get("t"));
  const t = Number.isFinite(rawT) && rawT >= 0 ? Math.round(rawT) : 0;

  const rawSpeed = Number(params.get("speed"));
  const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : DEFAULT_SPEED;

  const rawView = params.get("view")?.trim() as ViewId | undefined;
  const view = rawView && VALID_VIEWS.has(rawView) ? rawView : DEFAULT_VIEW_ID;

  const rawMode = params.get("mode")?.trim() as AppMode | undefined;
  const mode = rawMode && VALID_MODES.has(rawMode) ? rawMode : DEFAULT_MODE;

  const compare = params.get("compare")?.trim() || undefined;
  const req = params.get("req")?.trim() || undefined;
  const pod = params.get("pod")?.trim() || undefined;

  return {
    scenario,
    t,
    speed,
    view,
    mode,
    compare,
    req,
    pod
  };
}

export function serializeUrlState(state: UrlAppState): string {
  const params = new URLSearchParams();
  params.set("scenario", state.scenario);
  params.set("t", String(Math.max(0, Math.round(state.t))));
  params.set("speed", String(state.speed));
  params.set("view", state.view);
  params.set("mode", state.mode);
  if (state.compare) params.set("compare", state.compare);
  if (state.req) params.set("req", state.req);
  if (state.pod) params.set("pod", state.pod);
  return `?${params.toString()}`;
}

export function replaceUrlState(state: UrlAppState): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextSearch = serializeUrlState(state);
  if (window.location.search === nextSearch) {
    return;
  }
  const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}
