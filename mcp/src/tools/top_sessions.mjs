import { z } from 'zod';
import { formatTokens, formatUsd } from '../analyze/format.mjs';
import { RANGES, METRICS, resolveRaw, toolResult, loadApi } from './common.mjs';

function metricOf(session, metric) {
  return session.tokens?.[metric] ?? 0;
}

export function registerTopSessions(server, deps) {
  server.registerTool(
    'top_sessions',
    {
      title: 'Sesiones más caras',
      description: 'Ranking de sesiones (incluye subagentes). Sin `project`, recorre todos los proyectos.',
      inputSchema: {
        range: z.enum(RANGES).optional().default('30d'),
        project: z.string().optional(),
        metric: z.enum(METRICS).optional().default('effective'),
        limit: z.number().int().positive().max(100).optional().default(10),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ range, project, metric, limit, raw }) => {
      const { runId, raw: data, cached } = await resolveRaw({
        store: deps.store,
        tool: 'top_sessions',
        params: { range, project, metric, limit },
        load: async () => {
          if (project) {
            return loadApi({ api: deps.api, path: `/api/projects/${project}/sessions`, params: { range }, config: deps.config });
          }
          const projects = await loadApi({ api: deps.api, path: '/api/projects', params: { range }, config: deps.config });
          const items = [];
          for (const p of projects.items ?? []) {
            const sessions = await loadApi({
              api: deps.api,
              path: `/api/projects/${p.id}/sessions`,
              params: { range },
              config: deps.config,
            });
            for (const s of sessions.items ?? []) items.push({ ...s, projectId: p.id });
          }
          return { items };
        },
      });

      const top = [...(data.items ?? [])].sort((a, b) => metricOf(b, metric) - metricOf(a, metric)).slice(0, limit);
      const fmt = metric === 'cost' ? formatUsd : formatTokens;
      const lines = top.map((s) => {
        const tag = s.parentId ? ' [subagente]' : '';
        return `- ${s.title}${tag}: ${fmt(metricOf(s, metric))}`;
      });
      return toolResult({
        text: lines.length ? lines.join('\n') : 'Sin sesiones en el rango.',
        structured: { runId, cached, metric, items: top, raw: raw ? data : undefined },
      });
    },
  );
}
