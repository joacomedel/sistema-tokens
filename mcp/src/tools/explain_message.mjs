import { z } from 'zod';
import { formatTokens, formatUsd } from '../analyze/format.mjs';
import { resolveRaw, toolResult, loadApi } from './common.mjs';

function toolSummary(tools) {
  if (!Array.isArray(tools) || !tools.length) return 'sin tool calls';
  return tools.map((t) => `${t.name}×${t.count}`).join(', ');
}

export function registerExplainMessage(server, deps) {
  server.registerTool(
    'explain_message',
    {
      title: 'Detalle y disparador de un mensaje',
      description: 'Tokens, tools, qué lo disparó (prompt del usuario o task del subagente padre).',
      inputSchema: {
        messageId: z.string(),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ messageId, raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'explain_message',
        params: { messageId },
        load: () => loadApi({ api: deps.api, path: `/api/messages/${messageId}`, params: {}, config: deps.config }),
      });

      const t = data.tokens ?? {};
      const lines = [
        `${formatTokens(t.effective)} tokens efectivos · ${formatUsd(t.cost)}`,
        `input ${formatTokens(t.input)} · output ${formatTokens(t.output)} · reasoning ${formatTokens(t.reasoning)} · cacheRead ${formatTokens(t.cacheRead)}`,
        `Tools: ${toolSummary(data.tools)}`,
      ];
      const user = data.trigger?.user;
      const sub = data.trigger?.subagent;
      if (sub) lines.push(`Subagente lanzado desde ${sub.parentTitle || sub.parentSessionId} vía task.`);
      if (user?.text) lines.push(`Disparado por: ${user.text}`);
      return toolResult({ text: lines.join('\n'), structured: { runId, cached, raw: raw ? data : undefined } });
    },
  );
}
