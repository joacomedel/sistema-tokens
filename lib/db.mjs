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

export function listProjects(db, { fromMs = null, toMs = null, excludeModels = null } = {}) {
  const rf = overlapFilter(fromMs, toMs);
  const modelClause = excludeModels?.length ? `AND json_extract(s.model, '$.id') NOT IN (${excludeModels.map(() => '?').join(',')})` : '';
  const params = excludeModels?.length ? [...rf.params, ...excludeModels] : rf.params;
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
       WHERE 1 = 1 ${rf.sql} ${modelClause}
       GROUP BY p.id
       ORDER BY effective DESC`,
    )
    .all(...params);

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

export function listSessions(db, { projectId = null, fromMs = null, toMs = null, excludeModels = null } = {}) {
  const rf = overlapFilter(fromMs, toMs);
  const projectClause = projectId ? 'AND s.project_id = ?' : '';
  const modelClause = excludeModels?.length ? `AND json_extract(s.model, '$.id') NOT IN (${excludeModels.map(() => '?').join(',')})` : '';
  const params = [...(projectId ? [projectId] : []), ...(excludeModels?.length ? excludeModels : []), ...rf.params];

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
       WHERE 1 = 1 ${projectClause} ${modelClause} ${rf.sql}
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

function messageItemV1(row, data, text = '') {
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
    text,
    flags: [],
  };
}

function messageItemV2(row, data, text = '') {
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
    text,
    flags: [],
  };
}

/** Texto visible de un mensaje v2: concatena los bloques `text` del `content`. */
function messageTextV2(data) {
  if (!Array.isArray(data.content)) return '';
  const texts = [];
  for (const block of data.content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n\n');
}

/** Normaliza a una línea y recorta, para las previews de la lista. */
function previewText(text, max = 280) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
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

/** Concatena el texto de los parts type=text de un mensaje (prompt del usuario en v1). */
function textFromParts(db, messageId) {
  const rows = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(messageId);
  const texts = [];
  for (const row of rows) {
    const data = safeParse(row.data);
    if (data?.type === 'text' && typeof data.text === 'string') texts.push(data.text);
  }
  return texts.join('\n\n');
}

/** Map id→prompt de los mensajes de usuario de una sesión v1 (texto en `part`). */
function userPromptsV1(db, sessionId) {
  const rows = db
    .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId);
  const map = new Map();
  for (const row of rows) {
    const data = safeParse(row.data);
    if (!data || data.role !== 'user') continue;
    map.set(row.id, {
      messageId: row.id,
      text: textFromParts(db, row.id),
      timeCreated: data.time?.created ?? row.time_created,
    });
  }
  return map;
}

/** Prompts de usuario de una sesión v2, ordenados por `seq` (texto en `data.text`). */
function userPromptsV2(db, sessionId) {
  const rows = db
    .prepare("SELECT id, seq, time_created, data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC")
    .all(sessionId);
  return rows.map((row) => {
    const data = safeParse(row.data) ?? {};
    return {
      messageId: row.id,
      seq: row.seq,
      text: typeof data.text === 'string' ? data.text : '',
      timeCreated: data.time?.created ?? row.time_created,
    };
  });
}

/** User inmediatamente anterior a un `seq` dado; null si no hay. */
function precedingUser(prompts, seq) {
  let found = null;
  for (const p of prompts) {
    if (p.seq < seq) found = p;
    else break;
  }
  return found;
}

/** Deriva el disparador cross-sesión: el tool `task` del padre que lanzó esta sesión. */
function subagentTrigger(db, sessionId) {
  if (!sessionId) return null;
  const session = db.prepare('SELECT parent_id FROM session_v2 WHERE id = ?').get(sessionId);
  const parentId = session?.parent_id;
  if (!parentId) return null;

  const parent = db.prepare('SELECT title FROM session_v2 WHERE id = ?').get(parentId);
  const part = db
    .prepare("SELECT data FROM part WHERE session_id = ? AND instr(data, '\"task\"') > 0 AND instr(data, ?) > 0 ORDER BY time_created ASC LIMIT 1")
    .get(parentId, sessionId);
  const input = (part ? safeParse(part.data)?.state?.input : null) ?? {};

  return {
    parentSessionId: parentId,
    parentTitle: parent?.title ?? '',
    subagentType: input.subagent_type ?? null,
    description: input.description ?? null,
    prompt: typeof input.prompt === 'string' ? input.prompt : null,
  };
}

export function listMessages(db, sessionId, { fromMs = null, toMs = null, excludeModels = null } = {}) {
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
  if (excludeModels?.length) {
    const placeholders = excludeModels.map(() => '?').join(',');
    if (source === 'message') {
      clauses.push(`(json_valid(data) = 0 OR json_extract(data, '$.modelID') NOT IN (${placeholders}))`);
    } else {
      clauses.push(`(json_valid(data) = 0 OR json_extract(data, '$.model.id') NOT IN (${placeholders}))`);
    }
    params.push(...excludeModels);
  }

  const items = [];
  let skipped = 0;
  const subagent = subagentTrigger(db, sessionId);

  if (source === 'message') {
    const prompts = userPromptsV1(db, sessionId);
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
      const item = messageItemV1(row, data, previewText(textFromParts(db, row.id)));
      item.trigger = { user: prompts.get(data.parentID) ?? null, subagent };
      items.push(item);
    }
  } else {
    const prompts = userPromptsV2(db, sessionId);
    const rows = db
      .prepare(
        `SELECT id, seq, time_created, data FROM session_message WHERE ${clauses.join(' AND ')} AND type = 'assistant' ORDER BY time_created ASC`,
      )
      .all(...params);
    for (const row of rows) {
      const data = safeParse(row.data);
      if (!data || !data.tokens) {
        skipped += 1;
        continue;
      }
      const item = messageItemV2(row, data, previewText(messageTextV2(data)));
      item.trigger = { user: precedingUser(prompts, row.seq), subagent };
      items.push(item);
    }
  }

  return { items, skipped, source };
}

/**
 * Agrupa los mensajes de una sesión en "turnos": cada prompt del usuario y las
 * respuestas del modelo que disparó. Los mensajes sin user previo (arranque v2,
 * poda) caen en un turno sintético con id `__none__`.
 */
export function listTurns(db, sessionId, opts = {}) {
  const { items, skipped, source } = listMessages(db, sessionId, opts);
  const turns = [];
  const byId = new Map();

  for (const message of items) {
    const user = message.trigger?.user ?? null;
    const id = user?.messageId ?? '__none__';
    let turn = byId.get(id);
    if (!turn) {
      turn = { id, prompt: user?.text ?? '', promptTime: user?.timeCreated ?? null, messages: [] };
      byId.set(id, turn);
      turns.push(turn);
    }
    turn.messages.push(message);
  }

  for (const [index, turn] of turns.entries()) {
    turn.index = index;
    turn.messageCount = turn.messages.length;
    turn.tokens = sumMetrics(turn.messages.map((m) => m.tokens));
  }

  return { turns, skipped, source };
}

export function getMessageDetail(db, messageId) {
  let row = db.prepare('SELECT id, session_id, time_created, data FROM message WHERE id = ?').get(messageId);
  let item = null;
  let sessionId = null;
  let triggerUser = null;

  if (row) {
    const data = safeParse(row.data);
    if (!data || data.role !== 'assistant' || !data.tokens) return null;
    item = messageItemV1(row, data, textFromParts(db, row.id));
    sessionId = row.session_id;
    triggerUser = userPromptsV1(db, sessionId).get(data.parentID) ?? null;
  } else if (tableExists(db, 'session_message')) {
    row = db.prepare('SELECT id, session_id, seq, time_created, data FROM session_message WHERE id = ?').get(messageId);
    if (!row) return null;
    const data = safeParse(row.data);
    if (!data || !data.tokens) return null;
    item = messageItemV2(row, data, messageTextV2(data));
    sessionId = row.session_id;
    triggerUser = precedingUser(userPromptsV2(db, sessionId), row.seq);
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

  return { ...item, trigger: { user: triggerUser, subagent: subagentTrigger(db, sessionId) }, tools };
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

/** Set único de todos los modelos que aparecen en los mensajes (v1 y v2). */
export function listAllModels(db) {
  const models = new Set();
  // v1: modelID en message.data
  const v1 = db.prepare("SELECT DISTINCT json_extract(data, '$.modelID') AS model FROM message WHERE json_valid(data) = 1").all();
  for (const row of v1) {
    if (row.model) models.add(row.model);
  }
  // v2: model.id en session_message.data
  if (tableExists(db, 'session_message')) {
    const v2 = db.prepare("SELECT DISTINCT json_extract(data, '$.model.id') AS model FROM session_message WHERE json_valid(data) = 1").all();
    for (const row of v2) {
      if (row.model) models.add(row.model);
    }
  }
  return [...models].sort();
}
