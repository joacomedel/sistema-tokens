import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApiClient, ApiError } from '../src/client/api.mjs';

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

test('get arma query params y parsea JSON', async () => {
  await withServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url }));
    },
    async (baseUrl) => {
      const api = createApiClient({ baseUrl });
      const body = await api.get('/api/projects', { range: '7d' });
      assert.equal(body.url, '/api/projects?range=7d');
    },
  );
});

test('get lanza ApiError con status en no-2xx', async () => {
  await withServer(
    (req, res) => {
      res.statusCode = 500;
      res.end('boom');
    },
    async (baseUrl) => {
      const api = createApiClient({ baseUrl });
      await assert.rejects(
        () => api.get('/api/x'),
        (e) => e instanceof ApiError && e.status === 500,
      );
    },
  );
});

test('get lanza ApiError en timeout', async () => {
  await withServer(
    () => {
      // nunca responde
    },
    async (baseUrl) => {
      const api = createApiClient({ baseUrl, timeoutMs: 30 });
      await assert.rejects(() => api.get('/api/x'), ApiError);
    },
  );
});
