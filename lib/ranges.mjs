export const RANGES = ['today', '7d', '30d', 'month', 'all'];

const DAY_MS = 86400000;

const LABELS = {
  today: 'Hoy',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  month: 'Este mes',
  all: 'Todo',
};

/**
 * Resuelve un rango temporal a milisegundos epoch en hora local.
 * `all` no tiene límites (fromMs/toMs null). Rango inválido → Error.
 */
export function resolveRange(key, now = new Date()) {
  if (!Object.hasOwn(LABELS, key)) throw new Error(`range inválido: ${key}`);

  const toMs = key === 'all' ? null : now.getTime();
  let fromMs = null;

  switch (key) {
    case 'today':
      fromMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      break;
    case '7d':
      fromMs = now.getTime() - 7 * DAY_MS;
      break;
    case '30d':
      fromMs = now.getTime() - 30 * DAY_MS;
      break;
    case 'month':
      fromMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      break;
    case 'all':
      fromMs = null;
      break;
  }

  return { key, fromMs, toMs, label: LABELS[key] };
}
