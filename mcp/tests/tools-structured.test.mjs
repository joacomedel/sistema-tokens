import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerSpendOverview } from '../src/tools/spend_overview.mjs';
import { registerTopSessions } from '../src/tools/top_sessions.mjs';

const projects = {
  items: [
    { id: 'p1', label: 'animaciones', sessions: 3, metrics: { effective: 1000, cost: 1.5 } },
    { id: 'p2', label: 'motor', sessions: 1, metrics: { effective: 500, cost: 0.5 } },
  ],
  totals: { effective: 1500, cost: 2 },
};

test('spend_overview expone proyectos y totales en structuredContent sin raw', async () => {
  const { client, close } = await startHarness({
    tools: [registerSpendOverview],
    api: { get: async (p) => (p === '/api/projects' ? projects : {}) },
  });
  const res = await client.callTool({ name: 'spend_overview', arguments: { range: 'all' } });
  assert.equal(res.structuredContent.raw, undefined);
  assert.equal(res.structuredContent.totals.cost, 2);
  assert.equal(res.structuredContent.projects.length, 2);
  assert.equal(res.structuredContent.projects[0].label, 'animaciones');
  await close();
});

test('top_sessions expone el ranking en structuredContent sin raw', async () => {
  const { client, close } = await startHarness({
    tools: [registerTopSessions],
    api: {
      get: async (p) =>
        p === '/api/projects'
          ? projects
          : p === '/api/projects/p1/sessions'
            ? { items: [{ id: 's1', title: 'sesión cara', parentId: null, tokens: { cost: 1, effective: 100 } }] }
            : { items: [] },
    },
  });
  const res = await client.callTool({ name: 'top_sessions', arguments: { range: 'all', metric: 'cost' } });
  assert.equal(res.structuredContent.raw, undefined);
  assert.equal(res.structuredContent.items.length, 1);
  assert.equal(res.structuredContent.items[0].title, 'sesión cara');
  await close();
});
