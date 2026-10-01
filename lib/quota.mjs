const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const WINDOW_ORDER = ['rolling', 'weekly', 'monthly'];
const HOUR_MS = 3600000;

export const WINDOW_LABELS = {
  rolling: '5 horas',
  weekly: 'Semanal',
  monthly: 'Mensual',
};

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function toPercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toResetIso(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v) && v > 1e12) return new Date(v).toISOString();
  }
  return null;
}

/**
 * Parsea el payload indocumentado de /zen/go/v1/usage de forma tolerante.
 * Devuelve solo las ventanas conocidas presentes, en orden rolling/weekly/monthly.
 */
export function parseUsagePayload(payload) {
  let root = payload;
  if (typeof payload === 'string') {
    try {
      root = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  if (!root || typeof root !== 'object') return [];
  const usage = root.usage;
  if (!usage || typeof usage !== 'object') return [];

  const windows = [];
  for (const id of WINDOW_ORDER) {
    if (!Object.hasOwn(usage, id)) continue;
    const raw = usage[id];
    const obj = raw && typeof raw === 'object' ? raw : {};
    windows.push({
      id,
      label: WINDOW_LABELS[id],
      percent: toPercent(obj.percent ?? obj.percentage),
      resetsAt: toResetIso(obj.resetsAt, obj.resetAt, obj.reset_at),
    });
  }
  return windows;
}

function startOfWeekMs(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

function sumCost(db, fromMs, toMs) {
  const row = db
    .prepare(
      `SELECT SUM(json_extract(m.data, '$.cost')) AS cost
       FROM (SELECT data, time_created FROM message WHERE json_valid(data)) m
       WHERE json_extract(m.data, '$.role') = 'assistant'
         AND m.time_created >= ? AND m.time_created <= ?`,
    )
    .get(fromMs, toMs);
  return row?.cost ?? 0;
}

/**
 * Uso local por ventana: 5 h móviles, semana calendario (lunes) y mes calendario.
 * `percent` solo se calcula si hay límite manual en USD.
 */
export function localWindows(db, { now = new Date(), manualLimits = null } = {}) {
  const toMs = now.getTime();
  const froms = {
    rolling: toMs - 5 * HOUR_MS,
    weekly: startOfWeekMs(now),
    monthly: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
  };

  return WINDOW_ORDER.map((id) => {
    const usedUsd = round6(sumCost(db, froms[id], toMs));
    const limit = manualLimits?.[id] ?? null;
    return {
      id,
      label: WINDOW_LABELS[id],
      percent: limit ? Math.round((usedUsd / limit) * 100) : null,
      resetsAt: null,
      usedUsd,
    };
  });
}

function readTokens(db) {
  const tokens = [];
  const queries = ['SELECT value AS token FROM credential LIMIT 1', 'SELECT access_token AS token FROM account LIMIT 1'];
  for (const sql of queries) {
    try {
      const row = db.prepare(sql).get();
      if (row?.token) tokens.push(row.token);
    } catch {
      // tabla ausente (p. ej. fixture mínima): se ignora
    }
  }
  return tokens;
}

/**
 * Cuota del plan: intenta la API con las credenciales locales en orden
 * (provider → OAuth) y cae al cálculo local si nada responde.
 * Los tokens nunca salen de esta función ni aparecen en los errores.
 */
export async function getQuota({
  db,
  fetchImpl = fetch,
  now = new Date(),
  ttlSeconds = 60,
  cache = null,
  manualLimits = null,
  timeoutMs = 10000,
} = {}) {
  if (cache && cache.result && cache.fetchedAt != null && cache.fetchedAt + ttlSeconds * 1000 > now.getTime()) {
    return cache.result;
  }

  const tokens = readTokens(db);
  let lastError = tokens.length === 0 ? 'sin credenciales locales' : null;

  for (const token of tokens) {
    try {
      const res = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = `${res.status} ${res.statusText || 'error'}`.trim();
        continue;
      }
      const windows = parseUsagePayload(await res.text());
      if (!windows.length) {
        lastError = 'respuesta sin ventanas';
        continue;
      }
      const result = {
        source: 'api',
        error: null,
        fetchedAt: now.getTime(),
        windows: windows.map((w) => ({ ...w, usedUsd: null })),
      };
      if (cache) {
        cache.fetchedAt = now.getTime();
        cache.result = result;
      }
      return result;
    } catch (err) {
      lastError = `red: ${err?.message ?? String(err)}`;
    }
  }

  const result = {
    source: 'local',
    error: lastError,
    fetchedAt: now.getTime(),
    windows: localWindows(db, { now, manualLimits }),
  };
  if (cache) {
    cache.fetchedAt = now.getTime();
    cache.result = result;
  }
  return result;
}
