import { z } from 'zod';
import { toolResult } from './common.mjs';

export function registerRecall(server, deps) {
  server.registerTool(
    'recall',
    {
      title: 'Reconsultar análisis previos',
      description:
        'Lista runs guardados o recupera el raw de un run por id, sin volver a pegarle a la API ni recalcular. Acepta dotted path.',
      inputSchema: {
        runId: z.string().optional(),
        path: z.string().optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ runId, path, limit, raw }) => {
      if (!runId) {
        const entries = await deps.store.list({ limit });
        const text = entries.length
          ? entries.map((e) => `- ${e.runId} ${e.tool} ${JSON.stringify(e.params)} (${e.source}, ${e.bytes}b)`).join('\n')
          : 'Sin runs guardados.';
        return toolResult({ text, structured: { entries } });
      }

      try {
        const value = await deps.store.recall(runId, path);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return toolResult({ text, structured: { runId, path, value: raw ? value : undefined } });
      } catch {
        return { content: [{ type: 'text', text: `No hay run guardado con id ${runId}.` }], isError: true };
      }
    },
  );
}
