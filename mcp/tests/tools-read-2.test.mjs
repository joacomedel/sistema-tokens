import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerTopTurns } from '../src/tools/top_turns.mjs';
import { registerExplainMessage } from '../src/tools/explain_message.mjs';
import { registerQuotaStatus } from '../src/tools/quota_status.mjs';

test('top_turns lista turnos por costo', async () => {
  const { client, close } = await startHarness({
    tools: [registerTopTurns],
    api: {
      get: async () => ({
        turns: [{ id: 't1', index: 0, prompt: 'hola', messageCount: 2, tokens: { cost: 0.5, effective: 10 }, messages: [] }],
        totals: {},
      }),
    },
  });
  const res = await client.callTool({ name: 'top_turns', arguments: { sessionId: 's1', range: 'all' } });
  assert.match(res.content[0].text, /hola/);
  await close();
});

test('explain_message muestra tools y disparador', async () => {
  const { client, close } = await startHarness({
    tools: [registerExplainMessage],
    api: {
      get: async () => ({
        id: 'm1',
        tokens: { input: 10, cost: 0.01 },
        tools: [{ name: 'read', count: 2 }],
        trigger: { user: { text: 'hacé algo' }, subagent: null },
      }),
    },
  });
  const res = await client.callTool({ name: 'explain_message', arguments: { messageId: 'm1' } });
  assert.match(res.content[0].text, /read/);
  assert.match(res.content[0].text, /hacé algo/);
  await close();
});

test('quota_status tolera respuesta vacía', async () => {
  const { client, close } = await startHarness({ tools: [registerQuotaStatus], api: { get: async () => ({}) } });
  const res = await client.callTool({ name: 'quota_status', arguments: {} });
  assert.equal(typeof res.content[0].text, 'string');
  await close();
});
