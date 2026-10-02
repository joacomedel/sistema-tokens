import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.mjs';

test('buildServer se conecta por transporte en memoria', async () => {
  const server = buildServer({ config: {}, tools: [] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const version = client.getServerVersion();
  assert.equal(version.name, 'sistemaTokens');
  await client.close();
  await server.close();
});
