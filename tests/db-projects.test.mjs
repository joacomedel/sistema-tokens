import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureDb } from './helpers/fixture.mjs';
import { openDb, listProjects, listSessions } from '../lib/db.mjs';

const range = { fromMs: new Date(2026, 9, 1).getTime(), toMs: new Date(2026, 9, 2).getTime() };

let dir, db, ids;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  ids = makeFixtureDb(join(dir, 'fixture.db'));
  db = openDb(join(dir, 'fixture.db'));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('listProjects agrupa por proyecto con label y métricas', () => {
  const { items, totals } = listProjects(db, range);
  assert.equal(items.length, 2);

  const p1 = items.find((i) => i.id === ids.p1);
  assert.equal(p1.label, 'proj-a');
  assert.equal(p1.sessions, 2);
  assert.equal(p1.metrics.effective, 445);
  assert.equal(p1.metrics.total, 1950); // 445 effective + 1500 cache-read + 5 cache-write
  assert.ok(Math.abs(p1.metrics.cost - 0.035) < 1e-9);
  assert.deepEqual(p1.flagsSummary, { sessionsWithSignals: 0 });

  const p2 = items.find((i) => i.id === ids.p2);
  assert.equal(p2.label, 'Global');
  assert.equal(p2.metrics.effective, 15);
  assert.equal(p2.metrics.cost, 0);

  assert.equal(totals.effective, 460);
});

test('listSessions filtra por proyecto, marca subagentes y normaliza title', () => {
  const { items } = listSessions(db, { projectId: ids.p1, ...range });
  assert.equal(items.length, 2);

  const s1 = items.find((i) => i.id === ids.s1);
  const s2 = items.find((i) => i.id === ids.s2);

  assert.equal(s1.parentId, null);
  assert.equal(s2.parentId, ids.s1, 's2 es subagente de s1');
  assert.equal(s1.effective, 380);
  assert.equal(s1.tokens.effective, 380);
  assert.equal(s1.tokens.cacheRead, 1000);
  assert.equal(s1.modelId, 'model-a');
  assert.equal(s1.providerId, 'prov-a');
  assert.equal(s1.compacted, false);
  assert.equal(s2.title, '', 'title null se normaliza a cadena vacía');
});

test('rango sin datos devuelve items vacíos y totales en 0', () => {
  const empty = { fromMs: new Date(2027, 0, 1).getTime(), toMs: new Date(2027, 0, 2).getTime() };
  const { items, totals } = listProjects(db, empty);
  assert.deepEqual(items, []);
  assert.equal(totals.effective, 0);
  assert.equal(totals.cost, 0);
});

test('openDb tira error claro si la BD no existe', () => {
  assert.throws(() => openDb(join(dir, 'no-existe.db')), /BD no encontrada/);
});
