import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { guardSelect, createDbAccess } from '../src/client/db.mjs';

test('guardSelect acepta SELECT/WITH y agrega LIMIT', () => {
  assert.equal(guardSelect('SELECT 1'), 'SELECT 1 LIMIT 500');
  assert.equal(guardSelect('WITH t AS (SELECT 1) SELECT * FROM t'), 'WITH t AS (SELECT 1) SELECT * FROM t LIMIT 500');
  assert.equal(guardSelect('SELECT 1 LIMIT 10'), 'SELECT 1 LIMIT 10');
});

test('guardSelect rechaza escrituras y múltiples sentencias', () => {
  for (const sql of ['INSERT INTO x VALUES (1)', 'DROP TABLE x', 'PRAGMA writable_schema=ON', 'SELECT 1; DROP TABLE x']) {
    assert.throws(() => guardSelect(sql));
  }
});

test('query lee una BD real en modo read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-db-'));
  const path = join(dir, 'f.db');
  const rw = new DatabaseSync(path);
  rw.exec('CREATE TABLE t (id INTEGER, name TEXT)');
  rw.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
  rw.close();

  const db = createDbAccess({ dbPath: path });
  assert.equal(db.available(), true);
  assert.deepEqual(
    db.query('SELECT name FROM t ORDER BY id').map((r) => r.name),
    ['a', 'b'],
  );
  assert.throws(() => db.query('DELETE FROM t'));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
