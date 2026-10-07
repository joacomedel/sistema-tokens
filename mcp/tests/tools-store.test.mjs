import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerRecall } from '../src/tools/recall.mjs';

test('recall lista y recupera por id y path', async () => {
  const { client, deps, close } = await startHarness({ tools: [registerRecall] });
  const runId = await deps.store.put('x', {}, { a: { b: [1, 2] } });

  const list = await client.callTool({ name: 'recall', arguments: {} });
  assert.match(list.content[0].text, new RegExp(runId));

  const byPath = await client.callTool({ name: 'recall', arguments: { runId, path: 'a.b.0' } });
  assert.match(byPath.content[0].text, /1/);

  await close();
});
