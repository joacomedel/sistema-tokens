import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureDb, addSessionMessageFixtures, addTriggerFixtures } from './helpers/fixture.mjs';
import { openDb, listTurns } from '../lib/db.mjs';

const range = { fromMs: new Date(2026, 9, 1).getTime(), toMs: new Date(2026, 9, 2).getTime() };

function withFixture(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sistema-tokens-'));
  const path = join(dir, 'fixture.db');
  makeFixtureDb(path);
  setup?.(path);
  const db = openDb(path);
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('listTurns v1 agrupa los assistants bajo su prompt y suma tokens', () => {
  withFixture(addTriggerFixtures, (db) => {
    const { turns } = listTurns(db, 's6', range);
    assert.equal(turns.length, 1);

    const [turn] = turns;
    assert.equal(turn.id, 'u1');
    assert.equal(turn.prompt, '¿Qué es un MCP?');
    assert.equal(turn.index, 0);
    assert.equal(turn.messageCount, 2);
    assert.deepEqual(turn.messages.map((m) => m.id), ['a1', 'a2']);
    assert.equal(turn.tokens.effective, 40); // a1 15 + a2 25
    assert.ok(Math.abs(turn.tokens.cost - 0.002) < 1e-9);
  });
});

test('listTurns v1 de subagente cae en el turno sintético __none__', () => {
  withFixture(addTriggerFixtures, (db) => {
    const { turns } = listTurns(db, 's7', range);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].id, '__none__');
    assert.equal(turns[0].prompt, '');
    assert.equal(turns[0].promptTime, null);
    assert.equal(turns[0].messageCount, 1);
  });
});

test('listTurns v2 separa el arranque sin prompt del turno con user', () => {
  withFixture(addSessionMessageFixtures, (db) => {
    const { turns } = listTurns(db, 's4', range);
    assert.equal(turns.length, 2);

    assert.equal(turns[0].id, '__none__');
    assert.equal(turns[0].prompt, '');
    assert.deepEqual(turns[0].messages.map((m) => m.id), ['smv1']);

    assert.equal(turns[1].id, 'smv2');
    assert.equal(turns[1].prompt, 'hola');
    assert.equal(turns[1].index, 1);
    assert.deepEqual(turns[1].messages.map((m) => m.id), ['smv3']);
    assert.equal(turns[1].tokens.effective, 23);
  });
});

test('listTurns mantiene skipped y source del listado de mensajes', () => {
  withFixture(null, (db) => {
    const { skipped, source } = listTurns(db, 's1', range);
    assert.equal(skipped, 2);
    assert.equal(source, 'message');
  });
});
