import { z } from 'zod';
import { formatUsd } from '../analyze/format.mjs';
import { resolveRaw, toolResult, loadApi } from './common.mjs';

export function registerQuotaStatus(server, deps) {
  server.registerTool(
    'quota_status',
    {
      title: 'Cuota del plan',
      description: 'Ventanas de cuota del plan (percent usado, USD y reset), con parseo tolerante.',
      inputSchema: { raw: z.boolean().optional().default(false) },
    },
    async ({ raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'quota_status',
        params: {},
        load: () => loadApi({ api: deps.api, path: '/api/quota', params: {}, config: deps.config }),
      });

      const windows = Array.isArray(data.windows) ? data.windows : [];
      let lines;
      if (windows.length) {
        lines = windows.map((w) => {
          const pct = w.percent != null ? `${w.percent}%` : '—';
          const usd = w.usedUsd != null ? ` · ${formatUsd(w.usedUsd)}` : '';
          const reset = w.resetsAt ? ` (resetea ${w.resetsAt})` : '';
          return `- ${w.label}: ${pct}${usd}${reset}`;
        });
      } else if (data.error) {
        lines = [`Sin datos de cuota (${data.error}).`];
      } else {
        lines = ['Sin datos de cuota.'];
      }
      return toolResult({ text: lines.join('\n'), structured: { runId, cached, raw: raw ? data : undefined } });
    },
  );
}
