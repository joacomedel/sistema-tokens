import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerSpendOverview } from '../src/tools/spend_overview.mjs';
import { registerTopSessions } from '../src/tools/top_sessions.mjs';

const projects = {
  items: [{ id: 'p1', label: 'animaciones', sessions: 3, metrics: { effective: 1000, cost: 1.5 } }],
  totals: { effective: 1000, cost: 1.5 },
};

test('spend_overview resume proyectos y guarda raw', async () => {
  const { client, close } = await startHarness({
    tools: [registerSpendOverview],
    api: { get: async (p) => (p === '/api/projects' ? projects : {}) },
  });
  const res = await client.callTool({ name: 'spend_overview', arguments: { range: 'all' } });
  assert.match(res.content[0].text, /animaciones/);
  assert.ok(res.structuredContent.raw || res.structuredContent.runId);
  await close();
});

test('top_sessions sin project recorre todos los proyectos', async () => {
  const { client, close } = await startHarness({
    tools: [registerTopSessions],
    api: {
      get: async (p) =>
        p === '/api/projects'
          ? projects
          : { items: [{ id: 's1', title: 'sesión', parentId: null, tokens: { cost: 1, effective: 100 } }] },
    },
  });
  const res = await client.callTool({ name: 'top_sessions', arguments: { range: 'all', metric: 'cost' } });
  assert.match(res.content[0].text, /sesión/);
  await close();
});
