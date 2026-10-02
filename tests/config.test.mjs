import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveDbPath } from '../src/config.mjs';

test('loadConfig aplica defaults', () => {
  const c = loadConfig({}, { defaultStoreDir: '/tmp/runs' });
  assert.equal(c.apiUrl, 'http://127.0.0.1:4747');
  assert.equal(c.dbFallback, true);
  assert.equal(c.httpTimeoutMs, 5000);
  assert.equal(c.storeDir, '/tmp/runs');
  assert.equal(c.storeEnabled, true);
  assert.equal(c.cacheTtlMs, 600000);
});

test('loadConfig respeta el entorno', () => {
  const c = loadConfig(
    { SISTEMA_TOKENS_URL: 'http://x:1', MCP_STORE: '0', MCP_DB_FALLBACK: '0', MCP_CACHE_TTL_MS: '1000' },
    { defaultStoreDir: '/tmp/runs' },
  );
  assert.equal(c.apiUrl, 'http://x:1');
  assert.equal(c.storeEnabled, false);
  assert.equal(c.dbFallback, false);
  assert.equal(c.cacheTtlMs, 1000);
});

test('resolveDbPath prioriza OPENCODE_DB y cae a XDG_DATA_HOME', () => {
  assert.equal(resolveDbPath({ OPENCODE_DB: '/custom.db', XDG_DATA_HOME: '/data' }), '/custom.db');
  assert.equal(resolveDbPath({ XDG_DATA_HOME: '/data' }), '/data/opencode/opencode.db');
});
