import { z } from 'zod';
import { analyzeMessages, analyzeConcentration, analyzeFanout } from '../analyze/heuristics.mjs';
import { formatFindings } from '../analyze/format.mjs';
import { RANGES, resolveRaw, toolResult, loadApi } from './common.mjs';

const SCOPES = ['global', 'project', 'session', 'turn', 'message'];

const costOf = (child) => child.cost ?? child.tokens?.cost ?? 0;

function totalsFrom(children, extra = {}) {
  return { cost: Math.round(children.reduce((a, c) => a + costOf(c), 0) * 1e6) / 1e6, ...extra };
}

function topOf(children) {
  return [...children].sort((a, b) => costOf(b) - costOf(a))[0] ?? null;
}

function emptyResult(scope, range) {
  return { scope, subject: { id: null, label: scope }, range, totals: { cost: 0 }, findings: [], next: [] };
}

function get(deps, path, params, range) {
  return loadApi({ api: deps.api, path, params: params ?? { range }, config: deps.config });
}

async function collect({ deps, scope, id, sessionId, range }) {
  if (scope === 'global') {
    const projects = await get(deps, '/api/projects', { range });
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
    let projectId = id;
    if (!projectId) {
      const projects = await get(deps, '/api/projects', { range });
      projectId = topOf((projects.items ?? []).map((p) => ({ id: p.id, cost: p.metrics?.cost ?? 0 })))?.id;
    }
    if (!projectId) return emptyResult(scope, range);
    const sessions = await get(deps, `/api/projects/${projectId}/sessions`, { range });
    const items = sessions.items ?? [];
    const children = items.map((s) => ({ type: 'session', id: s.id, label: s.title, cost: s.tokens?.cost ?? 0 }));
    return {
      scope,
      subject: { id: projectId, label: projectId },
      range,
      totals: totalsFrom(children, { sessions: items.length }),
      findings: [analyzeConcentration(children), analyzeFanout(items)].filter(Boolean),
      next: topOf(children) ? [`diagnose scope=session id=${topOf(children).id}`] : [],
    };
  }

  if (scope === 'session') {
    let resolvedId = id;
    if (!resolvedId) {
      const projects = await get(deps, '/api/projects', { range });
      const all = [];
      for (const p of projects.items ?? []) {
        const sessions = await get(deps, `/api/projects/${p.id}/sessions`, { range });
        for (const s of sessions.items ?? []) all.push(s);
      }
      resolvedId = topOf(all.map((s) => ({ id: s.id, cost: s.tokens?.cost ?? 0 })))?.id;
    }
    if (!resolvedId) return emptyResult(scope, range);
    const data = await get(deps, `/api/sessions/${resolvedId}/turns`, { range });
    const turns = data.turns ?? [];
    const children = turns.map((t) => ({ type: 'turn', id: t.id, label: `Turno ${t.index + 1}`, cost: t.tokens?.cost ?? 0 }));
    const messages = turns.flatMap((t) => t.messages ?? []);
    return {
      scope,
      subject: { id: resolvedId, label: resolvedId },
      range,
      totals: totalsFrom(children, { turns: turns.length, messages: messages.length }),
      findings: [analyzeConcentration(children), ...analyzeMessages(messages)].filter(Boolean),
      next: topOf(children) ? [`diagnose scope=turn id=${topOf(children).id} sessionId=${resolvedId}`] : [],
    };
  }

  if (scope === 'turn') {
    if (!sessionId || !id) {
      throw new Error('diagnose scope=turn requiere sessionId e id. Probá primero diagnose scope=session.');
    }
    const data = await get(deps, `/api/sessions/${sessionId}/turns`, { range });
    const turn = (data.turns ?? []).find((t) => t.id === id) ?? null;
    if (!turn) return emptyResult(scope, range);
    const messages = turn.messages ?? [];
    const worst = topOf(messages.map((m) => ({ id: m.id, cost: m.tokens?.cost ?? 0 })));
    return {
      scope,
      subject: { id, label: `Turno ${turn.index + 1}` },
      range,
      totals: turn.tokens ?? { cost: 0 },
      findings: analyzeMessages(messages),
      next: worst ? [`explain_message messageId=${worst.id}`] : [],
    };
  }

  if (!id) throw new Error('diagnose scope=message requiere id. Probá primero diagnose scope=session o top_turns.');
  const detail = await get(deps, `/api/messages/${id}`, {}, range);
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
        'Diagnostica un nivel del árbol (global/project/session/turn/message) y devuelve hallazgos con evidencia y el próximo nivel a bajar. Sin `id`, arranca en el hijo más caro del scope.',
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
