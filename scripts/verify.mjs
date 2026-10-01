import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, aggregatesFromSessions } from '../lib/db.mjs';

const INT_FIELDS = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
const COST_TOLERANCE = 1e-6;

const SUM_COLUMNS = `
  SUM(json_extract(m.data, '$.tokens.input')) AS tokens_input,
  SUM(json_extract(m.data, '$.tokens.output')) AS tokens_output,
  SUM(json_extract(m.data, '$.tokens.reasoning')) AS tokens_reasoning,
  SUM(json_extract(m.data, '$.tokens.cache.read')) AS tokens_cache_read,
  SUM(json_extract(m.data, '$.tokens.cache.write')) AS tokens_cache_write,
  SUM(json_extract(m.data, '$.cost')) AS cost`;

function effectiveOf(row) {
  return (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0);
}

/** Sesiones v1: `message` es completa; cualquier diferencia es un error. */
function compareExact(session, sum, mismatches) {
  for (const field of INT_FIELDS) {
    const expected = session[field] ?? 0;
    const actual = sum[field] ?? 0;
    if (actual !== expected) {
      mismatches.push({ sessionId: session.id, field, session: expected, messages: actual });
    }
  }
  const sessionCost = session.cost ?? 0;
  const messageCost = sum.cost ?? 0;
  if (Math.abs(messageCost - sessionCost) > COST_TOLERANCE) {
    mismatches.push({ sessionId: session.id, field: 'cost', session: sessionCost, messages: messageCost });
  }
}

/** Sesiones v2: `session_message` puede estar podada; solo debe no exceder el total. */
function compareNotOver(session, sum, mismatches) {
  for (const field of INT_FIELDS) {
    const total = session[field] ?? 0;
    const visible = sum[field] ?? 0;
    if (visible > total) {
      mismatches.push({ sessionId: session.id, field, session: total, messages: visible });
    }
  }
  const totalCost = session.cost ?? 0;
  const visibleCost = sum.cost ?? 0;
  if (visibleCost - totalCost > COST_TOLERANCE) {
    mismatches.push({ sessionId: session.id, field: 'cost', session: totalCost, messages: visibleCost });
  }
}

/**
 * Verificación cruzada contra los agregados autoritativos de `session_v2`:
 *  - sesiones v1 (`message`): debe cuadrar exacto;
 *  - sesiones v2 (`session_message`): OpenCode poda los mensajes, así que se
 *    exige que lo visible no exceda el total; la diferencia se reporta como
 *    `partial` (poda conocida, no error).
 */
export function verifyDb(db) {
  const sessions = aggregatesFromSessions(db);

  const hasV1 = new Set(db.prepare('SELECT DISTINCT session_id FROM message').all().map((r) => r.session_id));
  const sumV1 = new Map(
    db
      .prepare(
        `SELECT m.session_id AS id, ${SUM_COLUMNS}
         FROM (SELECT session_id, data FROM message WHERE json_valid(data)) m
         WHERE json_extract(m.data, '$.role') = 'assistant'
         GROUP BY m.session_id`,
      )
      .all()
      .map((row) => [row.id, row]),
  );

  let sumV2 = new Map();
  try {
    sumV2 = new Map(
      db
        .prepare(
          `SELECT m.session_id AS id, ${SUM_COLUMNS}
           FROM (SELECT session_id, type, data FROM session_message WHERE json_valid(data)) m
           WHERE m.type = 'assistant'
           GROUP BY m.session_id`,
        )
        .all()
        .map((row) => [row.id, row]),
    );
  } catch {
    // BD sin tabla session_message (v1 pura): nada que verificar ahí
  }

  const mismatches = [];
  const partial = [];
  for (const session of sessions) {
    if (hasV1.has(session.id)) {
      compareExact(session, sumV1.get(session.id) ?? {}, mismatches);
    } else {
      const sum = sumV2.get(session.id) ?? {};
      const before = mismatches.length;
      compareNotOver(session, sum, mismatches);
      if (mismatches.length === before) {
        const visibleEffective = effectiveOf(sum);
        const totalEffective = effectiveOf(session);
        if (visibleEffective < totalEffective) {
          partial.push({ sessionId: session.id, visibleEffective, totalEffective });
        }
      }
    }
  }

  return { checked: sessions.length, mismatches, partial };
}

function defaultDbPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ?? defaultDbPath();
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    console.error(`No se pudo abrir la BD: ${err.message}`);
    process.exit(1);
  }

  const { checked, mismatches, partial } = verifyDb(db);
  if (mismatches.length === 0) {
    const suffix = partial.length ? `, ${partial.length} parciales por poda de OpenCode` : '';
    console.log(`OK ${checked}/${checked} sesiones${suffix}`);
  } else {
    console.error(`DISCREPANCIAS: ${mismatches.length} en ${checked} sesiones (${dbPath})`);
    for (const m of mismatches.slice(0, 20)) {
      console.error(`  ${m.sessionId} ${m.field}: session_v2=${m.session} vs mensajes=${m.messages}`);
    }
    if (mismatches.length > 20) console.error(`  … y ${mismatches.length - 20} más`);
    process.exitCode = 1;
  }
  db.close();
}
