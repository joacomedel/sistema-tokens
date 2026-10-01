import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureDb, addSessionMessageFixtures } from './helpers/fixture.mjs';
import { openDb, listMessages, getMessageDetail, getSessionTotals } from '../lib/db.mjs';

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

test('listMessages devuelve solo assistant válidos, en orden y con skipped', () => {
  const { items, skipped } = listMessages(db, ids.s1, range);
  assert.equal(items.length, 2);
  assert.equal(skipped, 2, 'JSON corrupto + assistant sin tokens');
  assert.deepEqual(items.map((i) => i.id), [ids.m1, ids.m2]);
});

test('MessageItem expone tokens, duración, modelo y agent', () => {
  const { items } = listMessages(db, ids.s1, range);
  const m1 = items.find((i) => i.id === ids.m1);
  assert.equal(m1.tokens.effective, 160);
  assert.equal(m1.tokens.cacheRead, 1000);
  assert.equal(m1.tokens.cost, 0.01);
  assert.equal(m1.durationMs, 5000);
  assert.equal(m1.modelId, 'model-a');
  assert.equal(m1.providerId, 'prov-a');
  assert.equal(m1.agent, 'build');
  assert.deepEqual(m1.flags, []);

  const m2 = items.find((i) => i.id === ids.m2);
  assert.equal(m2.durationMs, null, 'sin time.completed → null');
});

test('modelos gratuitos: cost 0 sin NaN ni undefined', () => {
  const { items } = listMessages(db, ids.s3, range);
  assert.equal(items.length, 1);
  assert.equal(items[0].tokens.cost, 0);
  assert.equal(items[0].tokens.effective, 15);
  assert.ok(Number.isFinite(items[0].tokens.total));
});

test('getMessageDetail agrupa tools por nombre e ignora parts corruptos', () => {
  const detail = getMessageDetail(db, ids.m1);
  assert.deepEqual(detail.tools, [
    { name: 'read', count: 2 },
    { name: 'bash', count: 1 },
  ]);
  assert.equal(detail.tokens.effective, 160);
  assert.deepEqual(detail.flags, []);
});

test('getMessageDetail devuelve null si el mensaje no existe', () => {
  assert.equal(getMessageDetail(db, 'nope'), null);
});

test('rango restringido filtra mensajes y skipped', () => {
  const { items, skipped } = listMessages(db, ids.s1, {
    fromMs: new Date(2026, 9, 1, 11).getTime(),
    toMs: new Date(2026, 9, 1, 13).getTime(),
  });
  assert.deepEqual(items.map((i) => i.id), [ids.m2]);
  assert.equal(skipped, 1, 'solo el sin-tokens cae dentro del rango');
});

test('sesiones v2-only: parsea session_message (model anidado) e ignora user', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir2, 'fixture.db');
  makeFixtureDb(path);
  addSessionMessageFixtures(path);
  const db2 = openDb(path);
  try {
    const { items, skipped } = listMessages(db2, 's4', range);
    assert.equal(items.length, 2, 'smv1 y smv3; smv2 es user');
    assert.equal(skipped, 0);

    const first = items[0];
    assert.equal(first.id, 'smv1');
    assert.equal(first.modelId, 'model-c');
    assert.equal(first.providerId, 'prov-c');
    assert.equal(first.variant, 'default');
    assert.equal(first.agent, 'build');
    assert.equal(first.tokens.effective, 65);
    assert.equal(first.tokens.cost, 0.04);
    assert.equal(first.durationMs, 10000);

    const detail = getMessageDetail(db2, 'smv1');
    assert.deepEqual(detail.tools, [{ name: 'read', count: 1 }]);
  } finally {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('getSessionTotals devuelve los agregados autoritativos', () => {
  const t1 = getSessionTotals(db, ids.s1);
  assert.equal(t1.effective, 380);
  assert.equal(t1.cost, 0.03);
  assert.equal(t1.timeCreated, new Date(2026, 9, 1, 10).getTime());
  assert.equal(t1.timeUpdated, new Date(2026, 9, 1, 12).getTime());
  assert.equal(getSessionTotals(db, 'nope'), null);
});
