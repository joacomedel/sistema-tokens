import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtureDb, addSessionMessageFixtures } from './helpers/fixture.mjs';
import { createServer } from '../server.mjs';

const fakeQuota = async () => ({ source: 'fake', error: null, fetchedAt: 123, windows: [] });

let dir, server, close, base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sistema-tokens-server-'));
  const dbPath = join(dir, 'fixture.db');
  makeFixtureDb(dbPath);
  ({ server, close } = createServer({ dbPath, quotaFetcher: fakeQuota }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/meta responde estado general', async () => {
  const res = await fetch(`${base}/api/meta`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.range, '30d');
  assert.equal(body.db.ok, true);
  assert.equal(body.quota.source, 'fake');
});

test('GET /api/projects agrupa con flagsSummary', async () => {
  const res = await fetch(`${base}/api/projects?range=all`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const p1 = body.items.find((i) => i.id === 'p1');
  assert.equal(p1.metrics.effective, 445);
  assert.equal(typeof p1.flagsSummary.sessionsWithSignals, 'number');
  assert.equal(body.totals.effective, 460);
});

test('GET /api/projects con range inválido → 400 JSON', async () => {
  const res = await fetch(`${base}/api/projects?range=xxx`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
});

test('GET /api/projects/:id/sessions lista sesiones del proyecto', async () => {
  const res = await fetch(`${base}/api/projects/p1/sessions?range=all`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 2);
  const s2 = body.items.find((i) => i.id === 's2');
  assert.equal(s2.parentId, 's1');
  assert.equal(body.totals.effective, 445);
});

test('GET /api/sessions/:id/messages devuelve mensajes, skipped y totals', async () => {
  const res = await fetch(`${base}/api/sessions/s1/messages?range=all`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 2);
  assert.equal(body.skipped, 2);
  assert.equal(body.totals.effective, 380);
});

test('GET /api/messages/:id devuelve detalle y 404 para inexistente', async () => {
  const ok = await fetch(`${base}/api/messages/m1`);
  assert.equal(ok.status, 200);
  const detail = await ok.json();
  assert.ok(Array.isArray(detail.tools));
  assert.deepEqual(detail.tools[0], { name: 'read', count: 2 });

  const missing = await fetch(`${base}/api/messages/nope`);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, 'not_found');
});

test('GET /api/quota usa el fetcher inyectado', async () => {
  const res = await fetch(`${base}/api/quota`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'fake');

  const refresh = await fetch(`${base}/api/quota?refresh=1`);
  assert.equal(refresh.status, 200);
});

test('GET / sirve el index y bloquea path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<div id="app">/);

  const evil = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
  assert.equal(evil.status, 404);
});

test('rango sin datos → items vacíos y totales en 0', async () => {
  const emptyPath = join(dir, 'empty.db');
  makeFixtureDb(emptyPath);
  const raw = new DatabaseSync(emptyPath);
  raw.exec('DELETE FROM message; DELETE FROM session_v2;');
  raw.close();

  const s2 = createServer({ dbPath: emptyPath, quotaFetcher: fakeQuota });
  await new Promise((resolve) => s2.server.listen(0, '127.0.0.1', resolve));
  try {
    const b2 = `http://127.0.0.1:${s2.server.address().port}`;
    const res = await fetch(`${b2}/api/projects?range=today`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.totals.effective, 0);
  } finally {
    await s2.close();
  }
});

test('cobertura parcial: sesión v2 podada reporta partial y sessionTotals', async () => {
  const v2Path = join(dir, 'v2.db');
  makeFixtureDb(v2Path);
  addSessionMessageFixtures(v2Path);
  const s4srv = createServer({ dbPath: v2Path, quotaFetcher: fakeQuota, now: () => new Date(2026, 9, 1, 16, 0) });
  await new Promise((resolve) => s4srv.server.listen(0, '127.0.0.1', resolve));
  try {
    const b = `http://127.0.0.1:${s4srv.server.address().port}`;

    const res = await fetch(`${b}/api/sessions/s4/messages?range=all`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.partial, true);
    assert.equal(body.source, 'session_message');
    assert.equal(body.sessionTotals.effective, 110);
    assert.equal(body.totals.effective, 88);

    const full = await fetch(`${b}/api/sessions/s1/messages?range=all`);
    const fullBody = await full.json();
    assert.equal(fullBody.partial, false);
    assert.equal(fullBody.source, 'message');
    assert.equal(fullBody.sessionTotals.effective, 380);

    // s5 cruzó la medianoche: con `today` el recorte es del rango, no poda.
    const today = await fetch(`${b}/api/sessions/s5/messages?range=today`);
    const todayBody = await today.json();
    assert.equal(todayBody.partial, false, 'rango que no cubre la vida completa: no es poda');

    // Con `7d` (cubre la vida completa) la diferencia sí es poda.
    const week = await fetch(`${b}/api/sessions/s5/messages?range=7d`);
    const weekBody = await week.json();
    assert.equal(weekBody.partial, true, 'rango completo + visible < total = poda');
  } finally {
    await s4srv.close();
  }
});

test('BD inexistente: meta degrada, projects 500, quota no rompe; close() libera', async () => {
  const s3 = createServer({ dbPath: join(dir, 'no-existe.db'), quotaFetcher: null });
  await new Promise((resolve) => s3.server.listen(0, '127.0.0.1', resolve));
  const b3 = `http://127.0.0.1:${s3.server.address().port}`;

  const meta = await fetch(`${b3}/api/meta`);
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).db.ok, false);

  const projects = await fetch(`${b3}/api/projects?range=all`);
  assert.equal(projects.status, 500);
  assert.match((await projects.json()).error.message, /BD no encontrada/);

  const quota = await fetch(`${b3}/api/quota`);
  assert.equal(quota.status, 200);
  const quotaBody = await quota.json();
  assert.equal(quotaBody.windows.length, 0);
  assert.match(quotaBody.error, /BD no disponible/);

  await s3.close();
  await assert.rejects(fetch(`${b3}/api/meta`));
});
