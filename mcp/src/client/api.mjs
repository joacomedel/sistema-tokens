export class ApiError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * Cliente mínimo para la API de sistemaTokens. `get(path, params)` devuelve el
 * JSON parseado o lanza ApiError (no-2xx, timeout o error de red).
 */
export function createApiClient({ baseUrl, timeoutMs = 5000, fetchImpl = fetch }) {
  async function get(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } catch (cause) {
      throw new ApiError(`request failed: ${url.pathname}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new ApiError(`HTTP ${res.status} for ${url.pathname}`, { status: res.status });
    return res.json();
  }

  return { get };
}
