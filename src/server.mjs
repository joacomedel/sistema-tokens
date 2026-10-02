import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSpendOverview } from './tools/spend_overview.mjs';
import { registerTopSessions } from './tools/top_sessions.mjs';
import { registerTopTurns } from './tools/top_turns.mjs';
import { registerExplainMessage } from './tools/explain_message.mjs';
import { registerQuotaStatus } from './tools/quota_status.mjs';
import { registerDiagnose } from './tools/diagnose.mjs';
import { registerRecall } from './tools/recall.mjs';
import { registerQueryDb } from './tools/query_db.mjs';

export const DEFAULT_TOOLS = [
  registerSpendOverview,
  registerTopSessions,
  registerTopTurns,
  registerExplainMessage,
  registerQuotaStatus,
  registerDiagnose,
  registerRecall,
  registerQueryDb,
];

/**
 * Crea el server MCP. `deps.tools` es opcional: si viene, registra solo esos
 * handlers (útil en tests); si no, registra el set completo.
 */
export function buildServer(deps = {}) {
  const server = new McpServer({ name: 'sistemaTokens', version: '0.1.0' });
  const tools = Array.isArray(deps.tools) ? deps.tools : DEFAULT_TOOLS;
  for (const register of tools) register(server, deps);
  return server;
}
