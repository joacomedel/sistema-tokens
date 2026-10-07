import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi } from '../src/tools/common.mjs';

test('loadApi da un error accionable cuando la API no responde', async () => {
  const api = {
    get: async () => {
      const err = new Error('boom');
      err.status = 0;
      throw err;
    },
  };
  await assert.rejects(
    () => loadApi({ api, path: '/api/projects', params: {}, config: { apiUrl: 'http://127.0.0.1:4747' } }),
    (err) => {
      assert.match(err.message, /npm start/);
      assert.match(err.message, /sistemaTokens/);
      assert.doesNotMatch(err.message, /query_db/);
      return true;
    },
  );
});
