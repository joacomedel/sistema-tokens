import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtureDb, addSessionMessageFixtures } from './helpers/fixture.mjs';
import { openDb } from '../lib/db.mjs';
import { verifyDb } from '../scripts/verify.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sistema-tokens-verify-'));
}

test('verifyDb: fixture consistente no reporta discrepancias', () => {
  const dir = tmpDir();
  const path = join(dir, 'fixture.db');
  makeFixtureDb(path);
  const db = openDb(path);

  const { checked, mismatches } = verifyDb(db);
  assert.equal(checked, 3, 's1, s2 y s3');
  assert.deepEqual(mismatches, []);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('verifyDb: detecta una sesión alterada', () => {
  const dir = tmpDir();
  const path = join(dir, 'fixture.db');
  makeFixtureDb(path);

  const raw = new DatabaseSync(path);
  raw.exec("UPDATE session_v2 SET tokens_input = tokens_input + 1 WHERE id = 's1'");
  raw.close();

  const db = openDb(path);
  const { checked, mismatches, partial } = verifyDb(db);
  assert.equal(checked, 3);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].sessionId, 's1');
  assert.equal(mismatches[0].field, 'tokens_input');
  assert.deepEqual(partial, []);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('verifyDb: sesiones v2 sin mensajes propios cuentan como parciales por poda', () => {
  const dir = tmpDir();
  const path = join(dir, 'fixture.db');
  makeFixtureDb(path);
  addSessionMessageFixtures(path); // s4: total 110, visible 88

  const db = openDb(path);
  const { checked, mismatches, partial } = verifyDb(db);
  assert.equal(checked, 4);
  assert.deepEqual(mismatches, []);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].sessionId, 's4');
  assert.ok(partial[0].visibleEffective < partial[0].totalEffective);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('verifyDb: visible mayor que el total es mismatch', () => {
  const dir = tmpDir();
  const path = join(dir, 'fixture.db');
  makeFixtureDb(path);
  addSessionMessageFixtures(path);

  const raw = new DatabaseSync(path);
  raw.exec("UPDATE session_v2 SET tokens_input = 1 WHERE id = 's4'");
  raw.close();

  const db = openDb(path);
  const { mismatches, partial } = verifyDb(db);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].sessionId, 's4');
  assert.equal(mismatches[0].field, 'tokens_input');
  assert.deepEqual(partial, []);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
