import { z } from 'zod';
import { formatUsd } from '../analyze/format.mjs';
import { RANGES, resolveRaw, toolResult } from './common.mjs';

function truncate(text, max = 80) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function registerTopTurns(server, deps) {
  server.registerTool(
    'top_turns',
    {
      title: 'Turnos más caros de una sesión',
      description: 'Turnos que concentran el gasto de una sesión, con su prompt y cantidad de mensajes.',
      inputSchema: {
        sessionId: z.string(),
        range: z.enum(RANGES).optional().default('30d'),
        limit: z.number().int().positive().max(100).optional().default(10),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, range, limit, raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'top_turns',
        params: { sessionId, range, limit },
        load: () => deps.api.get(`/api/sessions/${sessionId}/turns`, { range }),
      });

      const turns = [...(data.turns ?? [])].sort((a, b) => (b.tokens?.cost ?? 0) - (a.tokens?.cost ?? 0)).slice(0, limit);
      const lines = turns.map(
        (t) => `- Turno ${t.index + 1} (${t.messageCount} msgs, ${formatUsd(t.tokens?.cost)}): ${truncate(t.prompt) || '(sin prompt)'}`,
      );
      if (data.partial && data.sessionTotals) {
        lines.push(`\nOjo: la API poda los mensajes viejos; puede faltar gasto.`);
      }
      return toolResult({
        text: lines.length ? lines.join('\n') : 'Sin turnos en el rango.',
        structured: { runId, cached, raw: raw ? data : undefined },
      });
    },
  );
}
