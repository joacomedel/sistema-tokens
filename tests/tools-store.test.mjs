import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerRecall } from '../src/tools/recall.mjs';
import { registerQueryDb } from '../src/tools/query_db.mjs';

test('recall lista y recupera por id y path', async () => {
  const { client, deps, close } = await startHarness({ tools: [registerRecall] });
  const runId = await deps.store.put('x', {}, { a: { b: [1, 2] } });

  const list = await client.callTool({ name: 'recall', arguments: {} });
  assert.match(list.content[0].text, new RegExp(runId));

  const byPath = await client.callTool({ name: 'recall', arguments: { runId, path: 'a.b.0' } });
  assert.match(byPath.content[0].text, /1/);

  await close();
});

test('query_db devuelve filas y rechaza escrituras', async () => {
  const db = {
    available: () => true,
    query: (sql) => {
      if (/delete/i.test(sql)) throw new Error('blocked');
      return [{ n: 1 }];
    },
  };
  const { client, close } = await startHarness({ tools: [registerQueryDb], db });
  const ok = await client.callTool({ name: 'query_db', arguments: { sql: 'SELECT 1 AS n' } });
  assert.match(ok.content[0].text, /1/);
  const bad = await client.callTool({ name: 'query_db', arguments: { sql: 'DELETE FROM t' } });
  assert.equal(bad.isError, true);
  await close();
});

test('query_db avisa si no hay BD', async () => {
  const db = { available: () => false, query: () => [] };
  const { client, close } = await startHarness({ tools: [registerQueryDb], db });
  const res = await client.callTool({ name: 'query_db', arguments: { sql: 'SELECT 1' } });
  assert.equal(res.isError, true);
  await close();
});
