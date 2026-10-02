import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ruta de la BD de OpenCode: OPENCODE_DB manda; si no, XDG_DATA_HOME o ~/.local/share. */
export function resolveDbPath(env = process.env) {
  if (env.OPENCODE_DB) return env.OPENCODE_DB;
  const base = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

/** Config del MCP, derivada del entorno con defaults explícitos. */
export function loadConfig(env = process.env, { defaultStoreDir } = {}) {
  return {
    apiUrl: env.SISTEMA_TOKENS_URL ?? 'http://127.0.0.1:4747',
    dbPath: resolveDbPath(env),
    dbFallback: env.MCP_DB_FALLBACK !== '0',
    httpTimeoutMs: Number(env.MCP_HTTP_TIMEOUT_MS ?? 5000),
    storeDir: env.MCP_STORE_DIR ?? defaultStoreDir ?? join(process.cwd(), 'store'),
    storeEnabled: env.MCP_STORE !== '0',
    cacheTtlMs: Number(env.MCP_CACHE_TTL_MS ?? 600000),
  };
}
