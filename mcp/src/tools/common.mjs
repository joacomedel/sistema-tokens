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

/** Llama a la API y, si falla, lanza un error accionable (no un stacktrace crudo). */
export async function loadApi({ api, path, params, config }) {
  try {
    return await api.get(path, params);
  } catch (err) {
    const where = config?.apiUrl ?? 'la API de sistemaTokens';
    const reason = err?.status ? `HTTP ${err.status}` : 'no responde';
    throw new Error(
      `No se pudo consultar la API de sistemaTokens (${reason}) en ${path}. Levantá la app con 'npm start' en la raíz del repo (modo MCP estricto: sin la app no hay datos). URL: ${where}.`,
    );
  }
}
