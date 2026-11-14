import { describe, expect, it } from "vitest";
import { parseUrlState, serializeUrlState, type UrlAppState } from "../urlState.js";

describe("urlState", () => {
  it("parses defaults when query string is empty or malformed", () => {
    expect(parseUrlState("")).toEqual({
      scenario: "01-single-request",
      t: 0,
      speed: 1,
      view: "gpu-map",
      mode: "guided",
      compare: undefined,
      req: undefined,
      pod: undefined
    });

    const malformed = parseUrlState("?t=-50&speed=abc&view=bogus&mode=invalid");
    expect(malformed.t).toBe(0);
    expect(malformed.speed).toBe(1);
    expect(malformed.view).toBe("gpu-map");
    expect(malformed.mode).toBe("guided");
  });

  it("round-trips full URL query state", () => {
    const state: UrlAppState = {
      scenario: "04-kv-eviction-preemption",
      t: 123456,
      speed: 2,
      view: "metrics",
      mode: "guided",
      compare: "03-prefix-caching",
      req: "req_3",
      pod: "instance_0"
    };

    const search = serializeUrlState(state);
    expect(parseUrlState(search)).toEqual(state);
  });
});
