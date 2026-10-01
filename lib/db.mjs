import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RETRIES = 3;
const RETRY_DELAY_MS = 100;

/**
 * Abre la BD de OpenCode en modo solo-lectura.
 * Reintenta 3×100 ms por si WAL está momentáneamente bloqueado.
 */
export function openDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`BD no encontrada en ${dbPath}`);

  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function projectLabel(worktree, name) {
  if (name) return name;
  if (!worktree || worktree === '/') return 'Global';
  return basename(worktree) || 'Global';
}

function metricsFrom(row) {
  const input = row.input ?? 0;
  const output = row.output ?? 0;
  const reasoning = row.reasoning ?? 0;
  const cacheRead = row.cache_read ?? 0;
  const cacheWrite = row.cache_write ?? 0;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
    effective: input + output + reasoning,
    cost: round6(row.cost ?? 0),
  };
}

function sumMetrics(list) {
  const acc = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, effective: 0, cost: 0 };
  for (const m of list) {
    for (const key of Object.keys(acc)) acc[key] += m[key] ?? 0;
  }
  acc.cost = round6(acc.cost);
  return acc;
}

function rangeFilter(fromMs, toMs) {
  const clauses = [];
  const params = [];
  if (fromMs != null) {
    clauses.push('m.time_created >= ?');
    params.push(fromMs);
  }
  if (toMs != null) {
    clauses.push('m.time_created <= ?');
    params.push(toMs);
  }
  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

// Subquery con json_valid: los mensajes con JSON corrupto no rompen las
// agregaciones (json_extract sobre texto inválido lanzaría error).
const VALID_MESSAGES = '(SELECT id, session_id, time_created, data FROM message WHERE json_valid(data))';

const AGG_TOKENS = `
  SUM(json_extract(m.data, '$.tokens.input')) AS input,
  SUM(json_extract(m.data, '$.tokens.output')) AS output,
  SUM(json_extract(m.data, '$.tokens.reasoning')) AS reasoning,
  SUM(json_extract(m.data, '$.tokens.cache.read')) AS cache_read,
  SUM(json_extract(m.data, '$.tokens.cache.write')) AS cache_write,
  SUM(json_extract(m.data, '$.cost')) AS cost,
  SUM(json_extract(m.data, '$.tokens.input') + json_extract(m.data, '$.tokens.output') + json_extract(m.data, '$.tokens.reasoning')) AS effective`;

export function listProjects(db, { fromMs = null, toMs = null } = {}) {
  const rf = rangeFilter(fromMs, toMs);
  const rows = db
    .prepare(
      `SELECT p.id, p.worktree, p.name AS project_name,
              COUNT(DISTINCT m.session_id) AS sessions,
              ${AGG_TOKENS}
       FROM ${VALID_MESSAGES} m
       JOIN session_v2 s ON s.id = m.session_id
       JOIN project p ON p.id = s.project_id
       WHERE json_extract(m.data, '$.role') = 'assistant' ${rf.sql}
       GROUP BY p.id
       ORDER BY effective DESC`,
    )
    .all(...rf.params);

  const items = rows.map((row) => ({
    id: row.id,
    label: projectLabel(row.worktree, row.project_name),
    worktree: row.worktree,
    sessions: row.sessions,
    metrics: metricsFrom(row),
    flagsSummary: { sessionsWithSignals: 0 },
  }));

  return { items, totals: sumMetrics(items.map((i) => i.metrics)) };
}

export function listSessions(db, { projectId = null, fromMs = null, toMs = null } = {}) {
  const rf = rangeFilter(fromMs, toMs);
  const projectClause = projectId ? 'AND s.project_id = ?' : '';
  const params = projectId ? [projectId, ...rf.params] : [...rf.params];

  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.parent_id, s.title, s.directory, s.model,
              s.time_compacting, s.time_created, s.time_updated,
              ${AGG_TOKENS}
       FROM ${VALID_MESSAGES} m
       JOIN session_v2 s ON s.id = m.session_id
       WHERE json_extract(m.data, '$.role') = 'assistant' ${projectClause} ${rf.sql}
       GROUP BY s.id
       ORDER BY effective DESC`,
    )
    .all(...params);

  const items = rows.map((row) => {
    const model = safeParse(row.model) ?? {};
    const metrics = metricsFrom(row);
    return {
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id ?? null,
      title: row.title ?? '',
      directory: row.directory ?? '',
      modelId: model.id ?? null,
      providerId: model.providerID ?? null,
      variant: model.variant ?? null,
      effective: metrics.effective,
      tokens: metrics,
      compacted: row.time_compacting != null,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      flags: [],
    };
  });

  return { items, totals: sumMetrics(items.map((i) => i.tokens)) };
}

function metricsFromTokens(data) {
  const t = data.tokens ?? {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const reasoning = t.reasoning ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
    effective: input + output + reasoning,
    cost: round6(data.cost ?? 0),
  };
}

function messageItem(row, data) {
  const created = data.time?.created ?? null;
  const completed = data.time?.completed ?? null;
  return {
    id: row.id,
    timeCreated: row.time_created,
    durationMs: created != null && completed != null ? completed - created : null,
    modelId: data.modelID ?? null,
    providerId: data.providerID ?? null,
    variant: data.variant ?? null,
    agent: data.agent ?? null,
    tokens: metricsFromTokens(data),
    flags: [],
  };
}

export function listMessages(db, sessionId, { fromMs = null, toMs = null } = {}) {
  const clauses = ['session_id = ?'];
  const params = [sessionId];
  if (fromMs != null) {
    clauses.push('time_created >= ?');
    params.push(fromMs);
  }
  if (toMs != null) {
    clauses.push('time_created <= ?');
    params.push(toMs);
  }

  const rows = db
    .prepare(`SELECT id, time_created, data FROM message WHERE ${clauses.join(' AND ')} ORDER BY time_created ASC`)
    .all(...params);

  const items = [];
  let skipped = 0;
  for (const row of rows) {
    const data = safeParse(row.data);
    if (!data) {
      skipped += 1; // JSON corrupto: ilegible, se cuenta
      continue;
    }
    if (data.role !== 'assistant') continue; // los mensajes de usuario no pertenecen a esta vista
    if (!data.tokens) {
      skipped += 1; // assistant sin desglose de tokens
      continue;
    }
    items.push(messageItem(row, data));
  }
  return { items, skipped };
}

export function getMessageDetail(db, messageId) {
  const row = db.prepare('SELECT id, time_created, data FROM message WHERE id = ?').get(messageId);
  if (!row) return null;

  const data = safeParse(row.data);
  if (!data || data.role !== 'assistant' || !data.tokens) return null;

  const partRows = db.prepare('SELECT data FROM part WHERE message_id = ?').all(messageId);
  const counts = new Map();
  for (const part of partRows) {
    const partData = safeParse(part.data);
    if (!partData || partData.type !== 'tool' || !partData.tool) continue;
    counts.set(partData.tool, (counts.get(partData.tool) ?? 0) + 1);
  }
  const tools = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { ...messageItem(row, data), tools };
}

/** Cuenta sesiones hijas por sesión padre (para la señal `many_subagents`). */
export function childCounts(db) {
  const rows = db
    .prepare('SELECT parent_id, COUNT(*) AS n FROM session_v2 WHERE parent_id IS NOT NULL GROUP BY parent_id')
    .all();
  return new Map(rows.map((r) => [r.parent_id, r.n]));
}
