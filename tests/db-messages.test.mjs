import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureDb, addSessionMessageFixtures, addTriggerFixtures } from './helpers/fixture.mjs';
import { openDb, listMessages, getMessageDetail, getSessionTotals, listAllModels } from '../lib/db.mjs';

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

test('listMessages v1 resuelve el prompt del usuario que disparó el turno', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir2, 'fixture.db');
  makeFixtureDb(path);
  const trig = addTriggerFixtures(path);
  const db2 = openDb(path);
  try {
    const { items } = listMessages(db2, trig.s6, range);
    assert.deepEqual(items.map((i) => i.id), [trig.a1, trig.a2]);

    const a1 = items.find((i) => i.id === trig.a1);
    const a2 = items.find((i) => i.id === trig.a2);
    assert.equal(a1.trigger.user.text, '¿Qué es un MCP?');
    assert.equal(a1.trigger.user.messageId, trig.u1);
    assert.equal(a2.trigger.user.messageId, trig.u1, 'los assistants del mismo turno comparten el prompt');
    assert.equal(a1.text, 'Un MCP es un protocolo de contexto.', 'la lista trae la preview del texto');
    assert.equal(a2.text.length, 280, 'la preview se recorta a 280');
    assert.ok(a2.text.endsWith('…'));
  } finally {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('getMessageDetail v1 devuelve el disparador (prompt del usuario)', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir2, 'fixture.db');
  makeFixtureDb(path);
  const trig = addTriggerFixtures(path);
  const db2 = openDb(path);
  try {
    const detail = getMessageDetail(db2, trig.a1);
    assert.equal(detail.trigger.user.text, '¿Qué es un MCP?');
    assert.equal(detail.trigger.subagent, null);
    assert.equal(detail.text, 'Un MCP es un protocolo de contexto.', 'el detalle trae el texto completo');

    const longDetail = getMessageDetail(db2, trig.a2);
    assert.equal(longDetail.text.length, 400, 'sin recorte en el detalle');
  } finally {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('getMessageDetail de subagente devuelve la sesión padre y el task', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir2, 'fixture.db');
  makeFixtureDb(path);
  addTriggerFixtures(path);
  const db2 = openDb(path);
  try {
    const detail = getMessageDetail(db2, 'a3');
    assert.equal(detail.trigger.subagent.parentSessionId, 's6');
    assert.equal(detail.trigger.subagent.parentTitle, 'Parent v1');
    assert.equal(detail.trigger.subagent.subagentType, 'general');
    assert.equal(detail.trigger.subagent.description, 'Fix X');
    assert.equal(detail.trigger.subagent.prompt, 'Hacé esto');

    const { items } = listMessages(db2, 's7', range);
    assert.equal(items[0].trigger.subagent.parentSessionId, 's6', 'la lista también expone el task del padre');
  } finally {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('listMessages v2 resuelve el user anterior por seq', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir2, 'fixture.db');
  makeFixtureDb(path);
  addSessionMessageFixtures(path);
  const db2 = openDb(path);
  try {
    const { items } = listMessages(db2, 's4', range);
    const first = items.find((i) => i.id === 'smv1');
    const second = items.find((i) => i.id === 'smv3');
    assert.equal(first.trigger.user, null, 'sin user previo al primer assistant del turno');
    assert.equal(second.trigger.user.text, 'hola');
    assert.equal(second.trigger.user.messageId, 'smv2');
    assert.equal(second.text, 'Respuesta v2 a hola', 'v2: preview desde content');

    const detail = getMessageDetail(db2, 'smv3');
    assert.equal(detail.trigger.user.text, 'hola');
    assert.equal(detail.trigger.subagent, null);
    assert.equal(detail.text, 'Respuesta v2 a hola');
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

test('listMessages con excludeModels filtra mensajes por modelo', () => {
  const { items } = listMessages(db, ids.s1, { ...range, excludeModels: ['model-a'] });
  assert.equal(items.length, 0, 'todos los mensajes de s1 usan model-a');
});

test('listMessages con excludeModels en sesión con modelo distinto', () => {
  const { items } = listMessages(db, ids.s3, { ...range, excludeModels: ['model-b'] });
  assert.equal(items.length, 0, 's3 usa model-b');

  const { items: items2 } = listMessages(db, ids.s3, { ...range, excludeModels: ['model-a'] });
  assert.equal(items2.length, 1, 's3 no usa model-a, así que no se filtra');
});

test('listMessages con excludeModels múltiples', () => {
  const { items } = listMessages(db, ids.s1, { ...range, excludeModels: ['model-a', 'model-b'] });
  assert.equal(items.length, 0, 'todos los mensajes de s1 usan model-a');
});

test('listAllModels devuelve todos los modelos únicos', () => {
  const models = listAllModels(db);
  assert.deepEqual(models, ['model-a', 'model-b']);
});
