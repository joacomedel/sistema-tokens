import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './src/config.mjs';
import { buildServer } from './src/server.mjs';
import { createApiClient } from './src/client/api.mjs';
import { createDbAccess } from './src/client/db.mjs';
import { createStore } from './src/store/runs.mjs';
import { THRESHOLDS } from './src/analyze/thresholds.mjs';

const config = loadConfig(process.env, { defaultStoreDir: new URL('./store', import.meta.url).pathname });

const deps = {
  config,
  api: createApiClient({ baseUrl: config.apiUrl, timeoutMs: config.httpTimeoutMs }),
  db: createDbAccess({ dbPath: config.dbPath, enabled: config.dbFallback }),
  store: createStore({ dir: config.storeDir, ttlMs: config.cacheTtlMs, enabled: config.storeEnabled }),
  thresholds: THRESHOLDS,
};

// stdout es el canal JSON-RPC: los logs van por stderr.
const server = buildServer(deps);
await server.connect(new StdioServerTransport());
console.error('sistemaTokens-mcp listo');
