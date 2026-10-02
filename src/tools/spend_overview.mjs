import { z } from 'zod';
import { formatTokens, formatUsd } from '../analyze/format.mjs';
import { RANGES, resolveRaw, toolResult } from './common.mjs';

export function registerSpendOverview(server, deps) {
  server.registerTool(
    'spend_overview',
    {
      title: 'Resumen de gasto',
      description: 'Totales globales y top de proyectos por costo/uso. Punto de entrada barato.',
      inputSchema: {
        range: z.enum(RANGES).optional().default('30d'),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ range, raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'spend_overview',
        params: { range },
        load: () => deps.api.get('/api/projects', { range }),
      });

      const projects = [...(data.items ?? [])].sort((a, b) => (b.metrics?.cost ?? 0) - (a.metrics?.cost ?? 0)).slice(0, 10);
      const lines = [
        `Total: ${formatTokens(data.totals?.effective)} tokens efectivos · ${formatUsd(data.totals?.cost)}`,
        '',
        ...projects.map((p) => `- ${p.label}: ${formatUsd(p.metrics?.cost)} · ${p.sessions} sesiones`),
      ];
      return toolResult({
        text: lines.join('\n'),
        structured: { runId, cached, totals: data.totals, raw: raw ? data : undefined },
      });
    },
  );
}
