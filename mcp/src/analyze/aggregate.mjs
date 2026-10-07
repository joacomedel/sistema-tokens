function round6(n) {
  return Math.round((n ?? 0) * 1e6) / 1e6;
}

/** Suma una lista de métricas; redondea `cost` a 6 decimales como sistemaTokens. */
export function sumMetrics(list) {
  const acc = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, effective: 0, cost: 0 };
  for (const m of list) {
    for (const key of Object.keys(acc)) acc[key] += m?.[key] ?? 0;
  }
  acc.cost = round6(acc.cost);
  return acc;
}

/** Percentil nearest-rank: el menor valor con al menos p% de los datos por debajo. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/** Fracción del total que aportan los `k` valores más grandes (0 si el total es 0). */
export function topShare(values, k = 3) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const top = [...values].sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + b, 0);
  return top / total;
}
