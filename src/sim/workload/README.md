# Workload

Who sends requests, how long they are, and what happens between turns. Also the fixed delays of the front-end hops.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Workload | Closed-loop multi-turn sessions | Users wait for an answer, think, then re-send the whole conversation plus a new message. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
| Workload | Trace replay | Requests are injected at recorded times with recorded lengths, so a run can be repeated or compared exactly. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Contents

| File | Contents |
|---|---|
| [`index.ts`](index.ts) | Sessions, turns, length and think-time distributions |
| [`trace.ts`](trace.ts) | Trace replay: requests injected from a list (time, session, round, new tokens, output tokens), used by the conformance tests in [`/conformance`](../../../conformance/) |
| [`frontend.ts`](frontend.ts) | Delays of the hops before the router and to the pod |

## Extending

A new workload model (a heavy-tailed length distribution, an agent loop with tool calls) goes in its own file with its source and tests. The current generator would then become the first implementation of a `Workload` interface; trace replay (`trace.ts`) is the second, and for now it plugs in beside the generator rather than behind that interface.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Length distributions from real traces; lengths are uniform around a mean.
- Shared system prompts across sessions: only a session's own history is reused.
- Tool calls and agent loops.
