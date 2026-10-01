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
