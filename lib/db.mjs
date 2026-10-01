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

// Filtro por solapamiento temporal: sesiones activas dentro del rango.
// Los agregados por sesión (autoritativos) viven en session_v2; los mensajes
// individuales pueden estar podados por OpenCode, así que no se usan para totales.
function overlapFilter(fromMs, toMs) {
  const clauses = [];
  const params = [];
  if (fromMs != null) {
    clauses.push('s.time_updated >= ?');
    params.push(fromMs);
  }
  if (toMs != null) {
    clauses.push('s.time_created <= ?');
    params.push(toMs);
  }
  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

export function listProjects(db, { fromMs = null, toMs = null } = {}) {
  const rf = overlapFilter(fromMs, toMs);
  const rows = db
    .prepare(
      `SELECT p.id, p.worktree, p.name AS project_name,
              COUNT(*) AS sessions,
              SUM(s.tokens_input) AS input,
              SUM(s.tokens_output) AS output,
              SUM(s.tokens_reasoning) AS reasoning,
              SUM(s.tokens_cache_read) AS cache_read,
              SUM(s.tokens_cache_write) AS cache_write,
              SUM(s.cost) AS cost,
              SUM(s.tokens_input + s.tokens_output + s.tokens_reasoning) AS effective
       FROM session_v2 s
       JOIN project p ON p.id = s.project_id
       WHERE 1 = 1 ${rf.sql}
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
  const rf = overlapFilter(fromMs, toMs);
  const projectClause = projectId ? 'AND s.project_id = ?' : '';
  const params = projectId ? [projectId, ...rf.params] : [...rf.params];

  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.parent_id, s.title, s.directory, s.model,
              s.time_compacting, s.time_created, s.time_updated,
              s.tokens_input AS input,
              s.tokens_output AS output,
              s.tokens_reasoning AS reasoning,
              s.tokens_cache_read AS cache_read,
              s.tokens_cache_write AS cache_write,
              s.cost,
              (s.tokens_input + s.tokens_output + s.tokens_reasoning) AS effective
       FROM session_v2 s
       WHERE 1 = 1 ${projectClause} ${rf.sql}
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

function messageItemV1(row, data) {
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

function messageItemV2(row, data) {
  const model = data.model ?? {};
  const created = data.time?.created ?? null;
  const completed = data.time?.completed ?? null;
  return {
    id: row.id,
    timeCreated: row.time_created,
    durationMs: created != null && completed != null ? completed - created : null,
    modelId: model.id ?? null,
    providerId: model.providerID ?? null,
    variant: model.variant ?? null,
    agent: data.agent ?? null,
    tokens: metricsFromTokens(data),
    flags: [],
  };
}

// Fuente de mensajes por sesión:
//  - `message` (legacy v1): sesiones históricas; completa y consistente con session_v2.
//  - `session_message` (v2): sesiones nuevas; OpenCode la poda con el tiempo, así
//    que puede mostrar menos tokens que el total autoritativo de la sesión.
function tableExists(db, name) {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function messageSourceFor(db, sessionId) {
  if (tableExists(db, 'message')) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(sessionId);
    if (row.n > 0) return 'message';
  }
  return 'session_message';
}

export function listMessages(db, sessionId, { fromMs = null, toMs = null } = {}) {
  const source = messageSourceFor(db, sessionId);
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

  const items = [];
  let skipped = 0;

  if (source === 'message') {
    const rows = db
      .prepare(`SELECT id, time_created, data FROM message WHERE ${clauses.join(' AND ')} ORDER BY time_created ASC`)
      .all(...params);
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
      items.push(messageItemV1(row, data));
    }
  } else {
    const rows = db
      .prepare(
        `SELECT id, time_created, data FROM session_message WHERE ${clauses.join(' AND ')} AND type = 'assistant' ORDER BY time_created ASC`,
      )
      .all(...params);
    for (const row of rows) {
      const data = safeParse(row.data);
      if (!data || !data.tokens) {
        skipped += 1;
        continue;
      }
      items.push(messageItemV2(row, data));
    }
  }

  return { items, skipped, source };
}

export function getMessageDetail(db, messageId) {
  let row = db.prepare('SELECT id, time_created, data FROM message WHERE id = ?').get(messageId);
  let item = null;

  if (row) {
    const data = safeParse(row.data);
    if (!data || data.role !== 'assistant' || !data.tokens) return null;
    item = messageItemV1(row, data);
  } else if (tableExists(db, 'session_message')) {
    row = db.prepare('SELECT id, time_created, data FROM session_message WHERE id = ?').get(messageId);
    if (!row) return null;
    const data = safeParse(row.data);
    if (!data || !data.tokens) return null;
    item = messageItemV2(row, data);
  } else {
    return null;
  }

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

  return { ...item, tools };
}

/** Totales autoritativos de la sesión según session_v2 (cobertura completa). */
export function getSessionTotals(db, sessionId) {
  const row = db
    .prepare(
      `SELECT tokens_input AS input, tokens_output AS output, tokens_reasoning AS reasoning,
              tokens_cache_read AS cache_read, tokens_cache_write AS cache_write, cost,
              time_created, time_updated
       FROM session_v2 WHERE id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return { ...metricsFrom(row), timeCreated: row.time_created, timeUpdated: row.time_updated };
}

/** Cuenta sesiones hijas por sesión padre (para la señal `many_subagents`). */
export function childCounts(db) {
  const rows = db
    .prepare('SELECT parent_id, COUNT(*) AS n FROM session_v2 WHERE parent_id IS NOT NULL GROUP BY parent_id')
    .all();
  return new Map(rows.map((r) => [r.parent_id, r.n]));
}

/** Agregados crudos por sesión tal cual los guarda OpenCode (para scripts/verify.mjs). */
export function aggregatesFromSessions(db) {
  return db
    .prepare(
      'SELECT id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost FROM session_v2',
    )
    .all();
}
