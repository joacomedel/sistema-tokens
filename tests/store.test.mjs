import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store/runs.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'mcp-store-'));
}

test('put y getFresh respetan el TTL', async () => {
  const dir = tmp();
  let clock = 1000;
  const store = createStore({ dir, ttlMs: 500, now: () => clock });
  const runId = await store.put('diagnose', { scope: 'global' }, { findings: [] });
  assert.match(runId, /^[0-9a-f]{12}$/);
  assert.deepEqual(await store.getFresh('diagnose', { scope: 'global' }), { findings: [] });
  clock = 2000;
  assert.equal(await store.getFresh('diagnose', { scope: 'global' }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('recall devuelve raw completo o por dotted path', async () => {
  const dir = tmp();
  const store = createStore({ dir });
  const runId = await store.put('x', {}, { a: { b: [1, 2] } });
  assert.deepEqual(await store.recall(runId), { a: { b: [1, 2] } });
  assert.equal(await store.recall(runId, 'a.b.0'), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('list ordena por createdAt y store desactivado no guarda', async () => {
  const dir = tmp();
  const store = createStore({ dir, enabled: false });
  assert.equal(await store.put('x', {}, { a: 1 }), null);
  assert.deepEqual(await store.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('list ignora líneas inválidas del índice', async () => {
  const dir = tmp();
  let clock = 1;
  const store = createStore({ dir, now: () => clock++ });
  await store.put('a', {}, { n: 1 });
  await store.put('b', {}, { n: 2 });
  const { appendFile, readFile, writeFile } = await import('node:fs/promises');
  await appendFile(join(dir, 'index.jsonl'), '{ broken json\n');
  const entries = await store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].tool, 'b');
  rmSync(dir, { recursive: true, force: true });
});
