import { DatabaseSync } from 'node:sqlite';

const t = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi).getTime();

function tokensData({ time, completed, input, output, reasoning, cacheRead = 0, cacheWrite = 0, cost = 0, modelId = 'model-a', providerId = 'prov-a' }) {
  const tokens = {
    input,
    output,
    reasoning,
    total: input + output + reasoning + cacheRead + cacheWrite,
    cache: { read: cacheRead, write: cacheWrite },
  };
  const timeObj = completed != null ? { created: time, completed } : { created: time };
  return JSON.stringify({ role: 'assistant', cost, modelID: modelId, providerID: providerId, agent: 'build', time: timeObj, tokens });
}

/**
 * BD SQLite temporal con esquema mínimo de OpenCode v2 y datos conocidos.
 * Devuelve los ids para usar en los tests.
 */
export function makeFixtureDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT, directory TEXT, model TEXT, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);

  const T1 = t(2026, 9, 1, 10);
  const T2 = t(2026, 9, 1, 12);
  const T3 = t(2026, 9, 1, 13);
  const T4 = t(2026, 9, 1, 14);

  const p = db.prepare('INSERT INTO project VALUES (?,?,?,?,?)');
  p.run('p1', '/home/u/proj-a', null, T1, T4);
  p.run('p2', '/', null, T4, T4);

  const s = db.prepare(`INSERT INTO session_v2
    (id, project_id, parent_id, title, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  s.run('s1', 'p1', null, 'Sesión A', '/home/u/proj-a', JSON.stringify({ id: 'model-a', providerID: 'prov-a', variant: 'default' }), 0.03, 300, 70, 10, 1000, 5, T1, T2);
  s.run('s2', 'p1', 's1', null, '/home/u/proj-a', JSON.stringify({ id: 'model-a', providerID: 'prov-a' }), 0.005, 50, 10, 5, 500, 0, T3, T3);
  s.run('s3', 'p2', null, 'Sesión C', '/', JSON.stringify({ id: 'model-b', providerID: 'prov-b' }), 0, 10, 5, 0, 0, 0, T4, T4);

  const m = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  m.run('m1', 's1', T1, T1, tokensData({ time: T1, completed: T1 + 5000, input: 100, output: 50, reasoning: 10, cacheRead: 1000, cost: 0.01 }));
  m.run('m2', 's1', T2, T2, tokensData({ time: T2, input: 200, output: 20, reasoning: 0, cacheWrite: 5, cost: 0.02 }));
  m.run('m3', 's2', T3, T3, tokensData({ time: T3, input: 50, output: 10, reasoning: 5, cacheRead: 500, cost: 0.005 }));
  m.run('m4', 's3', T4, T4, tokensData({ time: T4, input: 10, output: 5, reasoning: 0, cost: 0, modelId: 'model-b', providerId: 'prov-b' }));
  m.run('m_corrupt', 's1', T1 + 1000, T1 + 1000, 'no-json{');
  m.run('m_notokens', 's1', T2 + 1000, T2 + 1000, JSON.stringify({ role: 'assistant', cost: 0, time: { created: T2 + 1000 } }));

  const pt = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  const tool = (name) => JSON.stringify({ type: 'tool', tool: name, callID: `c-${name}`, state: { status: 'completed' } });
  pt.run('pt1', 'm1', 's1', T1, T1, tool('read'));
  pt.run('pt2', 'm1', 's1', T1, T1, tool('read'));
  pt.run('pt3', 'm1', 's1', T1, T1, tool('bash'));
  pt.run('pt4', 'm1', 's1', T1, T1, 'nope{');

  db.close();
  return { p1: 'p1', p2: 'p2', s1: 's1', s2: 's2', s3: 's3', m1: 'm1', m2: 'm2', m3: 'm3', m4: 'm4' };
}

/**
 * Sesión "v2-only" (sin filas en `message`): sus mensajes viven en
 * `session_message` con el shape de OpenCode v2, parcialmente podados.
 *   - s4 (p2): session_v2 total = 110 efectivos / cost 0.05
 *   - sesión visible: 65 + 23 = 88 efectivos (poda simulada)
 */
export function addSessionMessageFixtures(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(
    'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)',
  );

  const T5 = t(2026, 9, 1, 15);
  db.prepare(
    `INSERT INTO session_v2
       (id, project_id, parent_id, title, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('s4', 'p2', null, 'V2 only', '/', JSON.stringify({ id: 'model-c', providerID: 'prov-c', variant: 'default' }), 0.05, 100, 10, 0, 0, 0, T5, T5 + 1800000);

  const sm = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  sm.run(
    'smv1',
    's4',
    'assistant',
    0,
    T5,
    T5,
    JSON.stringify({
      agent: 'build',
      model: { providerID: 'prov-c', id: 'model-c', variant: 'default' },
      cost: 0.04,
      time: { created: T5, completed: T5 + 10000 },
      tokens: { input: 60, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );
  sm.run('smv2', 's4', 'user', 1, T5 + 1000, T5 + 1000, JSON.stringify({ text: 'hola', time: { created: T5 + 1000 } }));
  sm.run(
    'smv3',
    's4',
    'assistant',
    2,
    T5 + 2000,
    T5 + 2000,
    JSON.stringify({
      agent: 'build',
      model: { providerID: 'prov-c', id: 'model-c' },
      cost: 0.01,
      time: { created: T5 + 2000, completed: T5 + 3000 },
      tokens: { input: 20, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );

  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
    'pv1',
    'smv1',
    's4',
    T5,
    T5,
    JSON.stringify({ type: 'tool', tool: 'read', callID: 'cv1', state: { status: 'completed' } }),
  );

  // s5: vida cruzando la medianoche (30-sep 22:00 → 1-oct 01:00) y podada.
  // Sirve para distinguir "poda" de "recorte por rango".
  db.prepare(
    `INSERT INTO session_v2
       (id, project_id, parent_id, title, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('s5', 'p2', null, 'Cruzó medianoche', '/', JSON.stringify({ id: 'model-c', providerID: 'prov-c' }), 0.02, 50, 0, 0, 0, 0, t(2026, 8, 30, 22), t(2026, 9, 1, 1));
  sm.run(
    'smv4',
    's5',
    'assistant',
    0,
    t(2026, 8, 30, 22, 10),
    t(2026, 8, 30, 22, 10),
    JSON.stringify({
      agent: 'build',
      model: { providerID: 'prov-c', id: 'model-c' },
      cost: 0.01,
      time: { created: t(2026, 8, 30, 22, 10), completed: t(2026, 8, 30, 22, 10) },
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );

  db.close();
}
