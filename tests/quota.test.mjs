import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtureDb, addSessionMessageFixtures } from './helpers/fixture.mjs';
import { openDb } from '../lib/db.mjs';
import { parseUsagePayload, getQuota, localWindows } from '../lib/quota.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sistema-tokens-quota-'));
}

function withCreds(filePath, { credentials = [], account = null } = {}) {
  const raw = new DatabaseSync(filePath);
  raw.exec(
    'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT); CREATE TABLE account (id TEXT PRIMARY KEY, access_token TEXT);',
  );
  let i = 0;
  for (const [integrationId, value] of credentials) {
    raw.prepare('INSERT INTO credential VALUES (?, ?, ?)').run(`c${i++}`, integrationId, value);
  }
  if (account) raw.prepare('INSERT INTO account VALUES (?, ?)').run('a1', account);
  raw.close();
}

const ok = (body) => new Response(body, { status: 200 });
const err = (status) => new Response('{"type":"error"}', { status });

test('parseUsagePayload tolera variantes y no rompe con basura', () => {
  const payload = {
    usage: {
      rolling: { status: 'ok', percent: 10, resetsAt: '2026-10-01T18:00:00.000Z' },
      weekly: { status: 'ok', percent: '5' },
      monthly: { percentage: 2, reset_at: 1790893952000 },
    },
  };
  const w = parseUsagePayload(payload);
  assert.deepEqual(w.map((x) => x.id), ['rolling', 'weekly', 'monthly']);
  assert.equal(w[0].percent, 10);
  assert.equal(w[0].resetsAt, '2026-10-01T18:00:00.000Z');
  assert.equal(w[1].percent, 5);
  assert.equal(w[1].resetsAt, null);
  assert.equal(w[2].percent, 2);
  assert.equal(w[2].resetsAt, new Date(1790893952000).toISOString());

  assert.deepEqual(parseUsagePayload(JSON.stringify(payload)).map((x) => x.id), ['rolling', 'weekly', 'monthly']);
  assert.deepEqual(parseUsagePayload({ usage: {} }), []);
  assert.deepEqual(parseUsagePayload({}), []);
  assert.deepEqual(parseUsagePayload(null), []);
  assert.deepEqual(parseUsagePayload('<html>403</html>'), []);

  const empty = parseUsagePayload({ usage: { rolling: { status: 'mystery' } } });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].percent, null);
  assert.equal(empty[0].resetsAt, null);
});

test('getQuota: 200 con token del provider → source api y caché', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, { credentials: [['opencode', 'sk-test-cred']] });
  const db = openDb(path);

  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls += 1;
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test-cred');
    return ok('{"usage":{"rolling":{"percent":10},"weekly":{"percent":5},"monthly":{"percent":2}}}');
  };

  const now = new Date(2026, 9, 1, 12);
  const cache = { fetchedAt: null, result: null };
  const r1 = await getQuota({ db, fetchImpl: fakeFetch, now, ttlSeconds: 60, cache });
  assert.equal(r1.source, 'api');
  assert.equal(r1.error, null);
  assert.equal(r1.windows.length, 3);
  assert.equal(r1.windows[0].percent, 10);

  const r2 = await getQuota({ db, fetchImpl: fakeFetch, now: new Date(now.getTime() + 30000), ttlSeconds: 60, cache });
  assert.equal(r2.source, 'api');
  assert.equal(calls, 1, 'dentro del TTL no vuelve a llamar');

  await getQuota({ db, fetchImpl: fakeFetch, now: new Date(now.getTime() + 61000), ttlSeconds: 60, cache });
  assert.equal(calls, 2, 'pasado el TTL vuelve a llamar');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getQuota: usa la credencial del provider opencode y no otra', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, {
    credentials: [
      ['anthropic', 'sk-otro-provider'],
      ['opencode', 'sk-opencode'],
    ],
  });
  const db = openDb(path);

  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return ok('{"usage":{"rolling":{"percent":1}}}');
  };
  const r = await getQuota({ db, fetchImpl: fakeFetch, now: new Date(2026, 9, 1, 12), cache: null });
  assert.equal(r.source, 'api');
  assert.deepEqual(seen, ['Bearer sk-opencode'], 'no debe filtrar la key de otro provider');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getQuota: credential 401 y account 200 → usa la segunda', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, { credentials: [['opencode', 'sk-bad']], account: 'oauth-good' });
  const db = openDb(path);

  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return seen.length === 1 ? err(401) : ok('{"usage":{"rolling":{"percent":7}}}');
  };

  const r = await getQuota({ db, fetchImpl: fakeFetch, now: new Date(2026, 9, 1, 12), cache: null });
  assert.equal(r.source, 'api');
  assert.deepEqual(seen, ['Bearer sk-bad', 'Bearer oauth-good']);
  assert.equal(r.windows[0].percent, 7);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getQuota: ambas credenciales 401 → local con causa', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, { credentials: [['opencode', 'sk-bad']], account: 'oauth-bad' });
  const db = openDb(path);

  const r = await getQuota({ db, fetchImpl: async () => err(401), now: new Date(2026, 9, 1, 23), cache: null });
  assert.equal(r.source, 'local');
  assert.match(r.error, /401/);
  assert.equal(r.windows.length, 3);
  assert.equal(r.windows.find((w) => w.id === 'monthly').usedUsd, 0.035);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getQuota: red caída → local con error legible', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, { credentials: [['opencode', 'sk-test']] });
  const db = openDb(path);

  const r = await getQuota({
    db,
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
    now: new Date(2026, 9, 1, 12),
    cache: null,
  });
  assert.equal(r.source, 'local');
  assert.match(r.error, /^red:/);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getQuota: 200 sin ventanas parseables → local (no inventa datos)', async () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  withCreds(path, { credentials: [['opencode', 'sk-test']] });
  const db = openDb(path);

  const r = await getQuota({ db, fetchImpl: async () => ok('{}'), now: new Date(2026, 9, 1, 12), cache: null });
  assert.equal(r.source, 'local');
  assert.match(r.error, /sin ventanas/);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('localWindows: ventanas 5h/semana/mes con límites manuales', () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  const db = openDb(path);

  const late = new Date(2026, 9, 1, 23, 0);
  const w = localWindows(db, { now: late, manualLimits: { monthly: 0.07 } });
  assert.deepEqual(w.map((x) => x.id), ['rolling', 'weekly', 'monthly']);
  assert.equal(w.find((x) => x.id === 'monthly').usedUsd, 0.035);
  assert.equal(w.find((x) => x.id === 'monthly').percent, 50);
  assert.equal(w.find((x) => x.id === 'rolling').usedUsd, 0);
  assert.equal(w.find((x) => x.id === 'rolling').percent, null);
  assert.equal(w.find((x) => x.id === 'weekly').usedUsd, 0.035);

  const mid = new Date(2026, 9, 1, 14, 30);
  const w2 = localWindows(db, { now: mid });
  assert.equal(w2.find((x) => x.id === 'rolling').usedUsd, 0.035);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('localWindows cuenta el costo de sesiones v2 podadas (vía session_v2)', () => {
  const dir = tmpDir();
  const path = join(dir, 'q.db');
  makeFixtureDb(path);
  addSessionMessageFixtures(path); // s4: cost 0.05, time_updated 2026-10-01 15:30
  const db = openDb(path);

  const w = localWindows(db, { now: new Date(2026, 9, 1, 23, 0) });
  assert.equal(w.find((x) => x.id === 'monthly').usedUsd, 0.105, '0.035 (s1-s3) + 0.05 (s4) + 0.02 (s5)');
  assert.equal(w.find((x) => x.id === 'rolling').usedUsd, 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
