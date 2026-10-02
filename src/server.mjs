import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Crea el server MCP. `deps.tools` es opcional: si viene, registra solo esos
 * handlers; si no, `index.mjs` registra el set completo (Task 11).
 */
export function buildServer(deps = {}) {
  const server = new McpServer({ name: 'sistemaTokens', version: '0.1.0' });
  if (Array.isArray(deps.tools)) {
    for (const register of deps.tools) register(server, deps);
  }
  return server;
}
