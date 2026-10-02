import { z } from 'zod';
import { formatTokens } from '../analyze/format.mjs';
import { resolveRaw, toolResult } from './common.mjs';

export function registerQuotaStatus(server, deps) {
  server.registerTool(
    'quota_status',
    {
      title: 'Cuota del plan',
      description: 'Ventanas de cuota del plan, con parseo tolerante.',
      inputSchema: { raw: z.boolean().optional().default(false) },
    },
    async ({ raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'quota_status',
        params: {},
        load: () => deps.api.get('/api/quota'),
      });

      const windows = Array.isArray(data.windows) ? data.windows : [];
      const lines = windows.length
        ? windows.map((w) => `- ${w.label}: ${formatTokens(w.used)}/${formatTokens(w.limit)}${w.resetsAt ? ` (resetea ${w.resetsAt})` : ''}`)
        : ['Sin datos de cuota.'];
      return toolResult({ text: lines.join('\n'), structured: { runId, cached, raw: raw ? data : undefined } });
    },
  );
}
