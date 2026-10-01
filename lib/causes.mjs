export const FLAG_LABELS = {
  no_cache: 'contexto sin cache',
  long_output: 'output largo',
  expensive_model: 'modelo caro',
  high_reasoning: 'razonamiento alto',
  compacted: 'se compactó',
  many_subagents: 'muchos subagentes',
};

const MESSAGE_PRIORITY = ['no_cache', 'expensive_model', 'long_output', 'high_reasoning'];
const SESSION_PRIORITY = [...MESSAGE_PRIORITY, 'compacted', 'many_subagents'];

const MAX_FLAGS = 2;

/**
 * Percentil nearest-rank: ordena ascendente y toma clamp(ceil(p*n)-1, 0, n-1).
 * Set vacío → null.
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function thresholdsFor(items) {
  return {
    p75Input: percentile(items.map((i) => i.tokens.input), 0.75),
    p90Output: percentile(items.map((i) => i.tokens.output), 0.9),
    p90Reasoning: percentile(items.map((i) => i.tokens.reasoning), 0.9),
    perToken: items.filter((i) => i.tokens.effective > 0).map((i) => i.tokens.cost / i.tokens.effective),
    n: items.length,
  };
}

function tokenFlagCodes(tokens, th) {
  const codes = [];
  if (tokens.input > 0 && tokens.cacheRead === 0 && tokens.input >= th.p75Input) codes.push('no_cache');
  if (tokens.output > 0 && tokens.output >= th.p90Output) codes.push('long_output');
  if (tokens.reasoning > 0 && tokens.reasoning >= th.p90Reasoning) codes.push('high_reasoning');

  const med = median(th.perToken);
  if (
    th.n >= 5 &&
    med != null &&
    med > 0 &&
    tokens.effective > 0 &&
    tokens.cost / tokens.effective >= 2 * med
  ) {
    codes.push('expensive_model');
  }
  return codes;
}

function toFlags(codes, priorityList) {
  return priorityList
    .filter((code) => codes.includes(code))
    .slice(0, MAX_FLAGS)
    .map((code) => ({ code, label: FLAG_LABELS[code], severity: priorityList.indexOf(code) }));
}

/** Anota cada mensaje con sus flags, usando el set completo como referencia. */
export function annotateMessages(items) {
  if (!items.length) return;
  const th = thresholdsFor(items);
  for (const item of items) {
    item.flags = toFlags(tokenFlagCodes(item.tokens, th), MESSAGE_PRIORITY);
  }
}

/** Anota cada sesión con sus flags (incluye compacted y subagentes). */
export function annotateSessions(items, { childCounts = new Map() } = {}) {
  if (!items.length) return;
  const th = thresholdsFor(items);
  for (const item of items) {
    const codes = tokenFlagCodes(item.tokens, th);
    if (item.compacted === true) codes.push('compacted');
    if ((childCounts.get(item.id) ?? 0) >= 5) codes.push('many_subagents');
    item.flags = toFlags(codes, SESSION_PRIORITY);
  }
}

export function summarizeFlags(sessionItems) {
  return { sessionsWithSignals: sessionItems.filter((i) => i.flags.length > 0).length };
}
