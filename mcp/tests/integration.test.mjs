import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.mjs';
import { createApiClient } from '../src/client/api.mjs';
import { createStore } from '../src/store/runs.mjs';
import { THRESHOLDS } from '../src/analyze/thresholds.mjs';

test('el server registra las 7 tools sin acceso a BD', async () => {
  const server = buildServer({
    config: { cacheTtlMs: 600000 },
    api: createApiClient({ baseUrl: 'http://127.0.0.1:1' }),
    store: createStore({ dir: '/tmp/mcp-int', enabled: false }),
    thresholds: THRESHOLDS,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'diagnose',
    'explain_message',
    'quota_status',
    'recall',
    'spend_overview',
    'top_sessions',
    'top_turns',
  ]);
  await client.close();
  await server.close();
});
