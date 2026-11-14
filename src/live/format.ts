/** Number formatting for the interface. */
export const fmtGB = (bytes: number, digits = 1) => `${(bytes / 1e9).toFixed(digits)} GB`;
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${(s * 1e3).toFixed(s < 0.01 ? 1 : 0)} ms`);
