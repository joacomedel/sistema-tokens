import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Ordena claves recursivamente para que el hash sea estable. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stable(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Resuelve un dotted path (`a.b.0`) sobre un objeto. */
function pickPath(value, path) {
  if (!path) return value;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), value);
}

async function readIndex(indexFile) {
  let text;
  try {
    text = await readFile(indexFile, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // línea corrupta: se ignora
    }
  }
  return entries;
}

/**
 * Persistencia de runs: guarda el raw completo de cada análisis y un índice
 * con metadatos, para reutilizarlo dentro del TTL y reconsultarlo con `recall`.
 */
export function createStore({ dir, ttlMs = 600000, enabled = true, now = Date.now }) {
  const runsDir = join(dir, 'runs');
  const indexFile = join(dir, 'index.jsonl');

  function runIdFor(tool, params) {
    const hash = createHash('sha1').update(`${tool}\n${JSON.stringify(stable(params ?? {}))}`).digest('hex');
    return hash.slice(0, 12);
  }

  async function put(tool, params, raw, { source = 'api' } = {}) {
    if (!enabled) return null;
    const runId = runIdFor(tool, params);
    await mkdir(runsDir, { recursive: true });
    const body = JSON.stringify(raw, null, 2);
    await writeFile(join(runsDir, `${runId}.json`), body);
    const entry = { runId, tool, params: params ?? {}, createdAt: now(), source, bytes: Buffer.byteLength(body) };
    await appendFile(indexFile, `${JSON.stringify(entry)}\n`);
    return runId;
  }

  async function latestFor(runId) {
    const entries = await readIndex(indexFile);
    let latest = null;
    for (const entry of entries) {
      if (entry.runId !== runId) continue;
      if (!latest || entry.createdAt > latest.createdAt) latest = entry;
    }
    return latest;
  }

  async function getFresh(tool, params) {
    if (!enabled) return null;
    const runId = runIdFor(tool, params);
    const latest = await latestFor(runId);
    if (!latest || now() - latest.createdAt > ttlMs) return null;
    try {
      return JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async function list({ limit = 20 } = {}) {
    if (!enabled) return [];
    const entries = await readIndex(indexFile);
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async function recall(runId, path) {
    if (!enabled) throw new Error('store is disabled');
    const raw = JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8'));
    return pickPath(raw, path);
  }

  return { runIdFor, put, getFresh, list, recall };
}
