import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerSpendOverview } from '../src/tools/spend_overview.mjs';
import { registerQuotaStatus } from '../src/tools/quota_status.mjs';
import { registerDiagnose } from '../src/tools/diagnose.mjs';

test('si la API falla, el tool devuelve un error accionable', async () => {
  const api = {
    get: async () => {
      throw new Error('boom');
    },
  };
  const { client, close } = await startHarness({ tools: [registerSpendOverview], api });
  const res = await client.callTool({ name: 'spend_overview', arguments: { range: 'all' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /sistemaTokens/);
  assert.match(res.content[0].text, /Levantá/);
  await close();
});

test('quota_status usa el shape real de la API', async () => {
  const api = {
    get: async () => ({
      source: 'api',
      windows: [{ id: 'w', label: 'Semana', percent: 75, usedUsd: 3.5, resetsAt: '2026-10-05' }],
    }),
  };
  const { client, close } = await startHarness({ tools: [registerQuotaStatus], api });
  const res = await client.callTool({ name: 'quota_status', arguments: {} });
  assert.match(res.content[0].text, /75%/);
  assert.match(res.content[0].text, /\$3\.50/);
  await close();
});

test('diagnose project sin id arranca en el proyecto más caro', async () => {
  const projects = {
    items: [
      { id: 'p1', label: 'A', metrics: { cost: 1 } },
      { id: 'p2', label: 'B', metrics: { cost: 9 } },
    ],
  };
  const api = { get: async (p) => (p === '/api/projects' ? projects : { items: [] }) };
  const { client, close } = await startHarness({ tools: [registerDiagnose], api });
  const res = await client.callTool({ name: 'diagnose', arguments: { scope: 'project' } });
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.subject.id, 'p2');
  await close();
});
