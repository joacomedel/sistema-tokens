/**
 * Umbrales calibrados contra la BD real de OpenCode (2026-10-01).
 * Ver `docs/superpowers/specs/2026-10-01-sistemaTokens-mcp-design.md`.
 */
export const THRESHOLDS = {
  noCacheInput: 8000,
  cacheReadLowRatio: 0.1,
  lowCacheHitRatio: 0.9,
  largeContext: 120000,
  expensiveCostPerMessage: 0.01,
  shortOutput: 500,
  highReasoningShare: 0.25,
  longOutput: 1000,
  subagentFanout: 5,
  costConcentrationShare: 0.5,
  costConcentrationMinChildren: 5,
  repeatedToolCalls: 3,
};
