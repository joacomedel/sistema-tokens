import { z } from 'zod';
import { analyzeMessages, analyzeConcentration, analyzeFanout } from '../analyze/heuristics.mjs';
import { formatFindings } from '../analyze/format.mjs';
import { RANGES, resolveRaw, toolResult } from './common.mjs';

const SCOPES = ['global', 'project', 'session', 'turn', 'message'];

const costOf = (child) => child.cost ?? child.tokens?.cost ?? 0;

function totalsFrom(children, extra = {}) {
  return { cost: Math.round(children.reduce((a, c) => a + costOf(c), 0) * 1e6) / 1e6, ...extra };
}

function topOf(children) {
  return [...children].sort((a, b) => costOf(b) - costOf(a))[0] ?? null;
}

async function collect({ deps, scope, id, sessionId, range }) {
  if (scope === 'global') {
    const projects = await deps.api.get('/api/projects', { range });
    const children = (projects.items ?? []).map((p) => ({ type: 'project', id: p.id, label: p.label, cost: p.metrics?.cost ?? 0 }));
    return {
      scope,
      subject: { id: null, label: 'global' },
      range,
      totals: totalsFrom(children, { projects: children.length }),
      findings: [analyzeConcentration(children)].filter(Boolean),
      next: topOf(children) ? [`diagnose scope=project id=${topOf(children).id}`] : [],
    };
  }

  if (scope === 'project') {
    const sessions = await deps.api.get(`/api/projects/${id}/sessions`, { range });
    const items = sessions.items ?? [];
    const children = items.map((s) => ({ type: 'session', id: s.id, label: s.title, cost: s.tokens?.cost ?? 0 }));
    return {
      scope,
      subject: { id, label: id },
      range,
      totals: totalsFrom(children, { sessions: items.length }),
      findings: [analyzeConcentration(children), analyzeFanout(items)].filter(Boolean),
      next: topOf(children) ? [`diagnose scope=session id=${topOf(children).id}`] : [],
    };
  }

  if (scope === 'session') {
    const data = await deps.api.get(`/api/sessions/${id}/turns`, { range });
    const turns = data.turns ?? [];
    const children = turns.map((t) => ({ type: 'turn', id: t.id, label: `Turno ${t.index + 1}`, cost: t.tokens?.cost ?? 0 }));
    const messages = turns.flatMap((t) => t.messages ?? []);
    return {
      scope,
      subject: { id, label: id },
      range,
      totals: totalsFrom(children, { turns: turns.length, messages: messages.length }),
      findings: [analyzeConcentration(children), ...analyzeMessages(messages)].filter(Boolean),
      next: topOf(children) ? [`diagnose scope=turn id=${topOf(children).id} sessionId=${id}`] : [],
    };
  }

  if (scope === 'turn') {
    const data = await deps.api.get(`/api/sessions/${sessionId}/turns`, { range });
    const turn = (data.turns ?? []).find((t) => t.id === id) ?? null;
    if (!turn) return { scope, subject: { id, label: id }, range, totals: { cost: 0 }, findings: [], next: [] };
    const messages = turn.messages ?? [];
    const worst = topOf(messages.map((m) => ({ id: m.id, label: m.label, cost: m.tokens?.cost ?? 0 })));
    return {
      scope,
      subject: { id, label: `Turno ${turn.index + 1}` },
      range,
      totals: turn.tokens ?? { cost: 0 },
      findings: analyzeMessages(messages),
      next: worst ? [`explain_message messageId=${worst.id}`] : [],
    };
  }

  const detail = await deps.api.get(`/api/messages/${id}`);
  return {
    scope,
    subject: { id, label: id },
    range,
    totals: detail.tokens ?? { cost: 0 },
    findings: analyzeMessages([detail]),
    next: [],
  };
}

export function registerDiagnose(server, deps) {
  server.registerTool(
    'diagnose',
    {
      title: 'Diagnóstico causal del gasto',
      description:
        'Diagnostica un nivel del árbol (global/project/session/turn/message) y devuelve hallazgos con evidencia y el próximo nivel a bajar.',
      inputSchema: {
        scope: z.enum(SCOPES),
        id: z.string().optional(),
        sessionId: z.string().optional(),
        range: z.enum(RANGES).optional().default('30d'),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ scope, id, sessionId, range, raw }) => {
      const params = { scope, id, sessionId, range };
      const { runId, raw: result, cached } = await resolveRaw({
        store: deps.store,
        tool: 'diagnose',
        params,
        load: () => collect({ deps, scope, id, sessionId, range }),
      });
      return toolResult({
        text: formatFindings(result.findings),
        structured: { ...result, runId, cached, raw: raw ? result : undefined },
      });
    },
  );
}
