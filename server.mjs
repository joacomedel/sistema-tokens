import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, listProjects, listSessions, listMessages, listTurns, getMessageDetail, getSessionTotals, childCounts, listAllModels } from './lib/db.mjs';
import { resolveRange, RANGES } from './lib/ranges.mjs';
import { annotateMessages, annotateSessions } from './lib/causes.mjs';
import { getQuota } from './lib/quota.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function defaultDbPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function sumMetrics(list) {
  const acc = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, effective: 0, cost: 0 };
  for (const m of list) {
    for (const key of Object.keys(acc)) acc[key] += m[key] ?? 0;
  }
  acc.cost = round6(acc.cost);
  return acc;
}

/**
 * Solo es "poda" si el rango cubre la vida completa de la sesión; si no, la
 * diferencia entre lo visible y el total autoritativo se explica por el rango.
 */
function sessionCoverage(database, sessionId, range, totals) {
  const sessionTotals = getSessionTotals(database, sessionId);
  const coversSession =
    sessionTotals != null &&
    (range.fromMs == null || range.fromMs <= sessionTotals.timeCreated) &&
    (range.toMs == null || range.toMs >= sessionTotals.timeUpdated);
  const partial = Boolean(coversSession && totals.effective < sessionTotals.effective);
  return { sessionTotals, partial };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export function createServer({ dbPath = null, config = {}, quotaFetcher = null, now = () => new Date() } = {}) {
  const resolvedDbPath = dbPath ?? config.dbPath ?? defaultDbPath();
  const ttlSeconds = config.quota?.ttlSeconds ?? 60;
  const manualLimits = config.quota?.manualLimits ?? null;
  const quotaCache = { fetchedAt: null, result: null };

  let db = null;
  let dbError = null;

  function ensureDb() {
    if (db) return db;
    if (dbError) throw dbError;
    try {
      db = openDb(resolvedDbPath);
      return db;
    } catch (err) {
      dbError = err;
      throw err;
    }
  }

  function dbStatus() {
    try {
      ensureDb();
      return true;
    } catch {
      return false;
    }
  }

  async function currentQuota(refresh) {
    if (quotaFetcher) return quotaFetcher({ refresh: Boolean(refresh) });

    let database = null;
    try {
      database = ensureDb();
    } catch {
      // sin BD no hay ventanas locales que calcular
    }
    if (!database) {
      return { source: 'local', error: 'BD no disponible', fetchedAt: Date.now(), windows: [] };
    }
    if (refresh) {
      quotaCache.fetchedAt = null;
      quotaCache.result = null;
    }
    return getQuota({ db: database, cache: quotaCache, manualLimits, ttlSeconds });
  }

  function parseRange(url, res) {
    const key = url.searchParams.get('range') ?? '30d';
    if (!RANGES.includes(key)) {
      sendError(res, 400, 'bad_request', `range inválido: ${key}`);
      return null;
    }
    return resolveRange(key, now());
  }

  function withDb(res, fn) {
    let database;
    try {
      database = ensureDb();
    } catch (err) {
      sendError(res, 500, 'db_error', err?.message ?? 'error de BD');
      return;
    }
    try {
      fn(database);
    } catch (err) {
      sendError(res, 500, 'db_error', err?.message ?? 'error de BD');
    }
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', recurso, id, sub...]
    const resource = parts[1];
    const id = parts[2];
    const sub = parts[3];

    if (resource === 'meta' && !id) {
      const quota = await currentQuota(false);
      return sendJson(res, 200, {
        range: '30d',
        db: { ok: dbStatus(), path: resolvedDbPath },
        quota: { source: quota.source, error: quota.error, fetchedAt: quota.fetchedAt },
      });
    }

    if (resource === 'models' && !id) {
      return withDb(res, (database) => {
        const models = listAllModels(database);
        sendJson(res, 200, { models });
      });
    }

    if (resource === 'quota' && !id) {
      const quota = await currentQuota(url.searchParams.get('refresh') === '1');
      return sendJson(res, 200, quota);
    }

    if (resource === 'projects' && !id) {
      const range = parseRange(url, res);
      if (!range) return;
      const excludeModels = url.searchParams.getAll('excludeModels');
      return withDb(res, (database) => {
        const { items, totals } = listProjects(database, { ...range, excludeModels });
        const sessions = listSessions(database, { ...range, excludeModels });
        annotateSessions(sessions.items, { childCounts: childCounts(database) });
        const byProject = new Map();
        for (const s of sessions.items) {
          byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + (s.flags.length > 0 ? 1 : 0));
        }
        for (const item of items) {
          item.flagsSummary = { sessionsWithSignals: byProject.get(item.id) ?? 0 };
        }
        sendJson(res, 200, { range: range.key, items, totals });
      });
    }

    if (resource === 'projects' && id && sub === 'sessions') {
      const range = parseRange(url, res);
      if (!range) return;
      const excludeModels = url.searchParams.getAll('excludeModels');
      return withDb(res, (database) => {
        const { items, totals } = listSessions(database, { projectId: id, ...range, excludeModels });
        annotateSessions(items, { childCounts: childCounts(database) });
        sendJson(res, 200, { range: range.key, items, totals });
      });
    }

    if (resource === 'sessions' && id && sub === 'messages') {
      const range = parseRange(url, res);
      if (!range) return;
      const excludeModels = url.searchParams.getAll('excludeModels');
      return withDb(res, (database) => {
        const { items, skipped, source } = listMessages(database, id, { ...range, excludeModels });
        annotateMessages(items);
        const totals = sumMetrics(items.map((i) => i.tokens));
        const { sessionTotals, partial } = sessionCoverage(database, id, range, totals);
        sendJson(res, 200, { range: range.key, items, skipped, totals, sessionTotals, partial, source });
      });
    }

    if (resource === 'sessions' && id && sub === 'turns') {
      const range = parseRange(url, res);
      if (!range) return;
      const excludeModels = url.searchParams.getAll('excludeModels');
      return withDb(res, (database) => {
        const { turns, skipped, source } = listTurns(database, id, { ...range, excludeModels });
        const items = turns.flatMap((t) => t.messages);
        annotateMessages(items); // flags sobre el set completo de la sesión
        const totals = sumMetrics(items.map((i) => i.tokens));
        const { sessionTotals, partial } = sessionCoverage(database, id, range, totals);
        sendJson(res, 200, { range: range.key, turns, skipped, totals, sessionTotals, partial, source });
      });
    }

    if (resource === 'messages' && id && !sub) {
      return withDb(res, (database) => {
        const detail = getMessageDetail(database, id);
        if (!detail) return sendError(res, 404, 'not_found', 'mensaje no encontrado');
        sendJson(res, 200, detail);
      });
    }

    return sendError(res, 404, 'not_found', 'ruta no encontrada');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 404, 'not_found', 'ruta no encontrada');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendError(res, 404, 'not_found', 'ruta inválida');
    }
    if (pathname === '/') pathname = '/index.html';

    const filePath = normalize(join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 404, 'not_found', 'ruta no encontrada');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return sendError(res, 404, 'not_found', 'no encontrado');

    const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(filePath));
  }

  const server = createHttpServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      return sendError(res, 400, 'bad_request', 'URL inválida');
    }

    const handler = url.pathname === '/api' || url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url);
    Promise.resolve(handler).catch((err) => {
      if (!res.headersSent) sendError(res, 500, 'internal', err?.message ?? 'error interno');
      else res.end();
    });
  });

  async function close() {
    try {
      db?.close();
    } catch {
      // ya cerrada
    }
    db = null;
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  return { server, close };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(fileURLToPath(new URL('./config.json', import.meta.url)), 'utf8'));
  } catch {
    // sin config: defaults
  }
  const { server } = createServer({ config });
  const port = Number(config.port) || 4747;
  server.listen(port, '127.0.0.1', () => {
    console.log(`sistemaTokens → http://127.0.0.1:${port}`);
  });
}
