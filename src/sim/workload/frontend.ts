/**
 * Time a request spends before it reaches the router and on its way to a pod.
 *
 * Illustrative constants, chosen so each hop is visible in slow motion. Real values depend on the
 * client's network and the gateway; none of them is from a measurement.
 */
export const FRONTEND_HOPS = {
  /** Client to the front end over the internet, seconds. */
  send: 0.06,
  /** Prompt assembly and tokenisation, fixed part, seconds. */
  tokenizeBase: 0.03,
  /** Tokenisation per prompt token, seconds. */
  tokenizePerToken: 4e-6,
  /** Front end to the gateway queue, seconds. */
  toGateway: 0.04,
  /** Router to the chosen pod inside the cluster, seconds. */
  toPod: 0.06
} as const;

/** Seconds to assemble and tokenise a prompt of `promptTokens` tokens. */
export function tokenizeSeconds(promptTokens: number): number {
  return FRONTEND_HOPS.tokenizeBase + FRONTEND_HOPS.tokenizePerToken * promptTokens;
}
