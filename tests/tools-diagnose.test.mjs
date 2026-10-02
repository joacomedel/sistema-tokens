import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerDiagnose } from '../src/tools/diagnose.mjs';

const projects = {
  items: [
    { id: 'p1', label: 'A', metrics: { cost: 9 } },
    { id: 'p2', label: 'B', metrics: { cost: 1 } },
    { id: 'p3', label: 'C', metrics: { cost: 1 } },
    { id: 'p4', label: 'D', metrics: { cost: 1 } },
    { id: 'p5', label: 'E', metrics: { cost: 1 } },
  ],
};
const turns = {
  turns: [
    {
      id: 't1',
      index: 0,
      prompt: 'x',
      messageCount: 1,
      tokens: { cost: 5 },
      messages: [{ id: 'm1', tokens: { input: 20000, cacheRead: 0, cost: 5, effective: 20000 } }],
    },
  ],
};

test('diagnose global concentra y sugiere bajar a project', async () => {
  const { client, close } = await startHarness({
    tools: [registerDiagnose],
    api: { get: async (p) => (p === '/api/projects' ? projects : turns) },
  });
  const res = await client.callTool({ name: 'diagnose', arguments: { scope: 'global', range: 'all' } });
  assert.match(res.content[0].text, /cost_concentration/);
  assert.ok(res.structuredContent.next.some((s) => s.includes('scope=project')));
  await close();
});

test('diagnose session detecta no_cache en mensajes', async () => {
  const { client, close } = await startHarness({ tools: [registerDiagnose], api: { get: async () => turns } });
  const res = await client.callTool({ name: 'diagnose', arguments: { scope: 'session', id: 's1', range: 'all' } });
  assert.match(res.content[0].text, /no_cache_input/);
  await close();
});
