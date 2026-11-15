import { describe, expect, it } from "vitest";
import { scorersFrom, scoresFrom } from "../generate.js";

const line = (msg: string) => `time="2026-11-15T13:06:38+01:00" level=debug msg="[llm-d] ${msg}"`;
const calc = (plugin: string, pod: number, score: number) => line(`Calculated score objectiveKey=standard priority=0x1 plugin=${plugin}/${plugin} endpoint=default/instance-${pod}-rank-0 score=${score}`);

const LOG = [
  line("Completed running profile handler Pick profiles successfully result=map[default:{Filters: [], Scorers: [queue-scorer/queue-scorer: 2.000000, prefix-cache-scorer/prefix-cache-scorer: 3.000000], Picker: max-score-picker/max-score-picker}]"),
  line("Request admitted objectiveKey=standard priority=0x1 requestID=request_0"),
  calc("queue-scorer", 1, 1),
  calc("queue-scorer", 0, 0.5),
  calc("prefix-cache-scorer", 0, 0),
  calc("prefix-cache-scorer", 1, 0.25),
  line("flow-controller: Item dispatched. flowKey=t:0 requestID=request_1"),
  calc("queue-scorer", 0, 1),
  calc("queue-scorer", 1, 1),
  calc("prefix-cache-scorer", 0, 0.75),
  calc("prefix-cache-scorer", 1, 0)
].join("\n");

describe("reading BLIS's log", () => {
  it("finds the scoring plugins and their weights", () => {
    expect(scorersFrom(LOG)).toEqual([
      { name: "queue-scorer", weight: 2 },
      { name: "prefix-cache-scorer", weight: 3 }
    ]);
  });

  it("assigns each score to its request, pod and plugin, for both ways a request reaches the scorers", () => {
    const m = scoresFrom(LOG, scorersFrom(LOG), 2);
    expect(m.get(0)).toEqual([
      [0.5, 0],
      [1, 0.25]
    ]);
    expect(m.get(1)).toEqual([
      [1, 0.75],
      [1, 0]
    ]);
  });

  it("reads no scorers from a router that configures none", () => {
    expect(scorersFrom(line("Pick profiles result=map[default:{Filters: [], Scorers: [], Picker: max-score-picker}]"))).toEqual([]);
  });
});
