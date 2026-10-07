import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server.mjs';
import { createStore } from '../../src/store/runs.mjs';
import { THRESHOLDS } from '../../src/analyze/thresholds.mjs';

/** Levanta el server con transporte en memoria y devuelve un Client listo. */
export async function startHarness({ tools, api } = {}) {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'mcp-h-')) });
  const deps = { config: { cacheTtlMs: 600000 }, api, store, thresholds: THRESHOLDS, tools };
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return {
    client,
    deps,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
