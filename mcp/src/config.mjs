import { join } from 'node:path';

/**
 * Config del MCP, derivada del entorno con defaults explícitos.
 * Modo estricto: el MCP solo habla con la API de sistemaTokens; sin la app
 * levantada no tiene acceso a los datos.
 */
export function loadConfig(env = process.env, { defaultStoreDir } = {}) {
  return {
    apiUrl: env.SISTEMA_TOKENS_URL ?? 'http://127.0.0.1:4747',
    httpTimeoutMs: Number(env.MCP_HTTP_TIMEOUT_MS ?? 5000),
    storeDir: env.MCP_STORE_DIR ?? defaultStoreDir ?? join(process.cwd(), 'store'),
    storeEnabled: env.MCP_STORE !== '0',
    cacheTtlMs: Number(env.MCP_CACHE_TTL_MS ?? 600000),
  };
}
