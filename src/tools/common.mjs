export const RANGES = ['today', '7d', '30d', 'month', 'all'];
export const METRICS = ['effective', 'cost', 'total', 'cacheRead'];

/**
 * Devuelve el raw de un tool reutilizando el run guardado si está dentro del
 * TTL; si no, lo obtiene con `load()` y lo persiste.
 */
export async function resolveRaw({ store, tool, params, load }) {
  const runId = store.runIdFor(tool, params);
  const fresh = await store.getFresh(tool, params);
  if (fresh) return { runId, raw: fresh, cached: true };
  const raw = await load();
  await store.put(tool, params, raw);
  return { runId, raw, cached: false };
}

/** Respuesta estándar de un tool MCP. */
export function toolResult({ text, structured = {} }) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
