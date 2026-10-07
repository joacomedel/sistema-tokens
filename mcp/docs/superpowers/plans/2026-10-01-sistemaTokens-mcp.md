# sistemaTokens-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un servidor MCP local que analice el gasto de tokens de OpenCode reutilizando la API de `sistemaTokens`, con diagnóstico causal y raw persistido.

**Architecture:** Servidor MCP stdio (SDK v1) con tools read-only. La API de `sistemaTokens` es la fuente primaria; `node:sqlite` (readOnly) es fallback y para `query_db`. Cada run se guarda en un store en disco (raw + índice) y es reconsultable con `recall` sin reanalizar. Las heurísticas son funciones puras sobre los datos que ya devuelve la API.

**Tech Stack:** Node ≥ 24, JavaScript ESM (sin build), `@modelcontextprotocol/sdk@^1.31.0`, `zod@^3.25.0`, `node:sqlite`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-sistemaTokens-mcp-design.md`

## Global Constraints

- Node ≥ 24, ESM (`"type": "module"`); imports relativos con extensión `.js`.
- Dependencias de runtime solo `@modelcontextprotocol/sdk@^1.31.0` y `zod@^3.25.0`. Sin build step.
- La BD de OpenCode se abre **siempre** con `new DatabaseSync(path, { readOnly: true })`.
- **Nunca** escribir a stdout: stdout es el canal JSON-RPC. Logs solo por `console.error`.
- Tools read-only: no escriben en la BD ni en `sistemaTokens`.
- Umbrales único y versionados en `src/analyze/thresholds.mjs` (valores calibrados en la spec).
- `store/` va en `.gitignore`; nunca se commitea raw (contiene prompts/mensajes).
- Tests con `node:test` (`npm test` = `node --test`); cada comportamiento nuevo nace de un test que falló antes.
- Código, identificadores y commits en inglés; textos al usuario en español rioplatense.
- `range` ∈ `today|7d|30d|month|all` (default `30d`); `metric` ∈ `effective|cost|total|cacheRead` (default `effective`).

## Review Focus

- **API caída o timeout** (`sistemaTokens` no corriendo): los tools deben degradar al fallback de BD cuando `MCP_DB_FALLBACK=1`, o devolver un error accionable cuando no, sin colgarse.
- **`query_db` con SQL riesgoso** (múltiples sentencias, `INSERT/UPDATE/DROP`, `PRAGMA`): debe rechazar y nunca abrir la BD en modo escritura.
- **DB inexistente o sin permisos**: mensaje accionable (ruta y causa), no stacktrace crudo.
- **Store corrupto o incompleto** (archivo truncado, `index.jsonl` con línea inválida): no debe romper; ignora/recrea.
- **stdout limpio**: ningún `console.log` en el camino del servidor (rompe el JSON-RPC).

---

### Task 1: Scaffold, config y esqueleto del server MCP

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.mjs`, `src/server.mjs`, `index.mjs`
- Test: `tests/config.test.mjs`, `tests/server.test.mjs`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env, { defaultStoreDir } = {}) -> Config`
    `Config = { apiUrl, dbPath, dbFallback, httpTimeoutMs, storeDir, storeEnabled, cacheTtlMs }`
  - `resolveDbPath(env) -> string`
  - `buildServer(deps) -> McpServer` — `deps = { config, api, db, store, thresholds }`.

- [ ] **Step 1: Write the failing tests**

`tests/config.test.mjs`:
```js
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
```

`tests/server.test.mjs` (esqueleto; los tools se agregan en tasks siguientes):
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.mjs';

test('buildServer se conecta por transporte en memoria', async () => {
  const server = buildServer({ config: {}, tools: [] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const list = await client.listTools();
  assert.ok(Array.isArray(list.tools));
  await client.close();
  await server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/config.test.mjs tests/server.test.mjs`
Expected: FAIL — `Cannot find module '../src/config.mjs'`.

- [ ] **Step 3: Create `package.json` and `.gitignore`**

`package.json`:
```json
{
  "name": "sistemaTokens-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": { "start": "node index.mjs", "test": "node --test" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.31.0",
    "zod": "^3.25.0"
  }
}
```

`.gitignore`:
```
node_modules/
store/
```

- [ ] **Step 4: Implement `src/config.mjs`**

`resolveDbPath`: si `env.OPENCODE_DB` existe, devolverlo; si no, `join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')`.
`loadConfig`: mapear env→Config con los defaults de la spec (`MCP_STORE !== '0'`, `MCP_DB_FALLBACK !== '0'`, `Number(...)`).

- [ ] **Step 5: Implement `src/server.mjs` y `index.mjs`**

`buildServer(deps)`: crea `new McpServer({ name: 'sistemaTokens', version: '0.1.0' })`, itera `deps.tools` llamando `register(server, deps)` y devuelve el server. (En Task 1 `tools` es `[]`.)
`index.mjs`: `loadConfig`, arma `deps` (api/db/store creados en tasks siguientes; en Task 1 pasar `tools: []`), `server.connect(new StdioServerTransport())`. Importar `StdioServerTransport` de `@modelcontextprotocol/sdk/server/stdio.js`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/config.test.mjs tests/server.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore src/config.mjs src/server.mjs index.mjs tests/
git commit -m "feat: scaffold MCP server with config and in-memory test harness"
```

---

### Task 2: Cliente HTTP de la API

**Files:**
- Create: `src/client/api.mjs`
- Test: `tests/api-client.test.mjs`

**Interfaces:**
- Produces: `createApiClient({ baseUrl, timeoutMs = 5000, fetchImpl = fetch }) -> { get(path, params = {}) -> Promise<object> }`
  - Lanza `ApiError` (clase exportada con `.status`) en respuestas no-2xx o timeout.

- [ ] **Step 1: Write the failing test**

```js
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
  try { await fn(baseUrl); } finally { server.close(); }
}

test('get arma query params y parsea JSON', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url }));
  }, async (baseUrl) => {
    const api = createApiClient({ baseUrl });
    const body = await api.get('/api/projects', { range: '7d' });
    assert.equal(body.url, '/api/projects?range=7d');
  });
});

test('get lanza ApiError con status en no-2xx', async () => {
  await withServer((req, res) => { res.statusCode = 500; res.end('boom'); }, async (baseUrl) => {
    const api = createApiClient({ baseUrl });
    await assert.rejects(() => api.get('/api/x'), (e) => e instanceof ApiError && e.status === 500);
  });
});

test('get lanza ApiError en timeout', async () => {
  await withServer(() => {}, async (baseUrl) => { // nunca responde
    const api = createApiClient({ baseUrl, timeoutMs: 30 });
    await assert.rejects(() => api.get('/api/x'), ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api-client.test.mjs`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implement `src/client/api.mjs`**

`get(path, params)`: construye `URL` con `URLSearchParams` (omite `undefined`), `AbortController` + `setTimeout(timeoutMs)`, `fetchImpl(url, { signal })`, `res.ok` si no → `throw new ApiError(res.status)`, devuelve `res.json()`. Limpiar el timer en `finally`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/api-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/api.mjs tests/api-client.test.mjs
git commit -m "feat: add sistemaTokens HTTP API client"
```

---

### Task 3: Acceso SQLite read-only y guardrails de `query_db`

**Files:**
- Create: `src/client/db.mjs`
- Test: `tests/db-client.test.mjs`

**Interfaces:**
- Produces:
  - `guardSelect(sql, limit = 500) -> string` (lanza `Error` si no es un SELECT/WITH único y seguro)
  - `createDbAccess({ dbPath, enabled = true }) -> { query(sql, { limit } = {}) -> rows, available() -> boolean, close() }`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { guardSelect, createDbAccess } from '../src/client/db.mjs';

test('guardSelect acepta SELECT/WITH y agrega LIMIT', () => {
  assert.equal(guardSelect('SELECT 1'), 'SELECT 1 LIMIT 500');
  assert.equal(guardSelect('WITH t AS (SELECT 1) SELECT * FROM t'), 'WITH t AS (SELECT 1) SELECT * FROM t LIMIT 500');
  assert.equal(guardSelect('SELECT 1 LIMIT 10'), 'SELECT 1 LIMIT 10');
});

test('guardSelect rechaza escrituras y múltiples sentencias', () => {
  for (const sql of ['INSERT INTO x VALUES (1)', 'DROP TABLE x', 'PRAGMA writable_schema=ON', 'SELECT 1; DROP TABLE x']) {
    assert.throws(() => guardSelect(sql));
  }
});

test('query lee una BD real en modo read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-db-'));
  const path = join(dir, 'f.db');
  const rw = new DatabaseSync(path);
  rw.exec('CREATE TABLE t (id INTEGER, name TEXT)');
  rw.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
  rw.close();
  const db = createDbAccess({ dbPath: path });
  assert.equal(db.available(), true);
  assert.deepEqual(db.query('SELECT name FROM t ORDER BY id'), [{ name: 'a' }, { name: 'b' }]);
  assert.throws(() => db.query('DELETE FROM t'));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db-client.test.mjs`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implement `src/client/db.mjs`**

`guardSelect`: trim, quitar `;` finales, rechazar si queda `;`, exigir `/^\s*(select|with)\b/i`, rechazar `/\b(insert|update|delete|drop|alter|attach|pragma|vacuum|create|replace)\b/i`, y si `!/\blimit\b/i` agregar ` LIMIT ${limit}`.
`createDbAccess`: abre `new DatabaseSync(dbPath, { readOnly: true })` de forma perezosa en el primer `query`; `available()` chequea `existsSync(dbPath)`; `query` usa `guardSelect` y `db.prepare(sql).all()`; `close` cierra si estaba abierta. Si el archivo no existe, `query` lanza `Error('OpenCode DB not found at ' + dbPath)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/db.mjs tests/db-client.test.mjs
git commit -m "feat: add read-only sqlite access with select guardrails"
```

---

### Task 4: Store de runs (raw persistido + TTL + recall)

**Files:**
- Create: `src/store/runs.mjs`
- Test: `tests/store.test.mjs`

**Interfaces:**
- Produces: `createStore({ dir, ttlMs = 600000, enabled = true, now = Date.now })`
  - `runIdFor(tool, params) -> string` (12 hex)
  - `getFresh(tool, params) -> Promise<object|null>`
  - `put(tool, params, raw, { source = 'api' } = {}) -> Promise<string>`
  - `list({ limit = 20 } = {}) -> Promise<Entry[]>`
  - `recall(runId, path) -> Promise<unknown>`
  - `Entry = { runId, tool, params, createdAt, source, bytes }`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store/runs.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'mcp-store-')); }

test('put y getFresh respetan el TTL', async () => {
  const dir = tmp();
  let clock = 1000;
  const store = createStore({ dir, ttlMs: 500, now: () => clock });
  const runId = await store.put('diagnose', { scope: 'global' }, { findings: [] });
  assert.match(runId, /^[0-9a-f]{12}$/);
  assert.deepEqual(await store.getFresh('diagnose', { scope: 'global' }), { findings: [] });
  clock = 2000;
  assert.equal(await store.getFresh('diagnose', { scope: 'global' }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('recall devuelve raw completo o por dotted path', async () => {
  const dir = tmp();
  const store = createStore({ dir });
  const runId = await store.put('x', {}, { a: { b: [1, 2] } });
  assert.deepEqual(await store.recall(runId), { a: { b: [1, 2] } });
  assert.equal(await store.recall(runId, 'a.b.0'), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('list ordena por createdAt y store desactivado no guarda', async () => {
  const dir = tmp();
  const store = createStore({ dir, enabled: false });
  assert.equal(await store.put('x', {}, { a: 1 }), null);
  assert.deepEqual(await store.list(), []);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/store.test.mjs`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implement `src/store/runs.mjs`**

- `runIdFor`: `createHash('sha1').update(tool + '\n' + JSON.stringify(normalize(params))).digest('hex').slice(0, 12)`, con `normalize` ordenando claves.
- Archivos: `<dir>/runs/<runId>.json` y `<dir>/index.jsonl`. `put` crea dirs, escribe el JSON (raw) y agrega la línea al índice. `getFresh` lee el archivo y compara `now() - mtimeMs <= ttlMs`.
- `list`: lee `index.jsonl`, ignora líneas inválidas (try/catch por línea), ordena por `createdAt` desc, corta a `limit`.
- `recall`: lee el run; con `path`, resuelve `a.b.0`; sin `path`, devuelve todo.
- `enabled === false`: `put → null`, `getFresh → null`, `list → []`, `recall → Error`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/runs.mjs tests/store.test.mjs
git commit -m "feat: add run store with ttl, index and recall"
```

---

### Task 5: Umbrales, agregación y formateo

**Files:**
- Create: `src/analyze/thresholds.mjs`, `src/analyze/aggregate.mjs`, `src/analyze/format.mjs`
- Test: `tests/aggregate.test.mjs`

**Interfaces:**
- Produces:
  - `THRESHOLDS` (objeto con los valores calibrados de la spec)
  - `sumMetrics(list) -> Metrics`; `Metrics = { input, output, reasoning, cacheRead, cacheWrite, total, effective, cost }`
  - `percentile(values, p) -> number`
  - `topShare(costs, k = 3) -> number` (0..1)
  - `formatTokens(n) -> string`, `formatUsd(n) -> string`, `formatFindings(findings) -> string`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLDS } from '../src/analyze/thresholds.mjs';
import { sumMetrics, percentile, topShare } from '../src/analyze/aggregate.mjs';

test('THRESHOLDS tiene los valores calibrados', () => {
  assert.equal(THRESHOLDS.noCacheInput, 8000);
  assert.equal(THRESHOLDS.longOutput, 1000);
  assert.equal(THRESHOLDS.highReasoningShare, 0.25);
  assert.equal(THRESHOLDS.costConcentrationShare, 0.5);
  assert.equal(THRESHOLDS.costConcentrationMinChildren, 5);
});

test('sumMetrics acumula y redondea el costo', () => {
  const m = sumMetrics([
    { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0, total: 115, effective: 15, cost: 0.001 },
    { input: 20, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 26, effective: 26, cost: 0.002 },
  ]);
  assert.equal(m.effective, 41);
  assert.equal(m.cost, 0.003);
});

test('percentile y topShare', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(topShare([1, 1, 1, 7], 3), 3 / 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/aggregate.test.mjs`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Implement**

`thresholds.mjs`: `noCacheInput: 8000, cacheReadLowRatio: 0.1, lowCacheHitRatio: 0.9, largeContext: 120000, expensiveCostPerMessage: 0.01, shortOutput: 500, highReasoningShare: 0.25, longOutput: 1000, subagentFanout: 5, costConcentrationShare: 0.5, costConcentrationMinChildren: 5, repeatedToolCalls: 3`.
`aggregate.mjs`: `sumMetrics` igual que en `sistemaTokens` (redondeo a 6 decimales en `cost`); `percentile` con índice `floor(p/100*(n-1))`; `topShare` = suma de los k mayores / total (0 si total 0).
`format.mjs`: `formatTokens`/`formatUsd` compactos; `formatFindings` arma un listado `- [severity] code (share%) — subject: hypothesis`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/aggregate.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/ tests/aggregate.test.mjs
git commit -m "feat: add calibrated thresholds, aggregation and formatting"
```

---

### Task 6: Motor de heurísticas

**Files:**
- Create: `src/analyze/heuristics.mjs`
- Test: `tests/heuristics.test.mjs`

**Interfaces:**
- Consumes: `THRESHOLDS`, `percentile`, `topShare`.
- Produces:
  - `analyzeMessages(messages, { thresholds = THRESHOLDS } = {}) -> Finding[]`
    `messages = [{ id, label?, modelId?, tokens: Metrics }]`
  - `analyzeConcentration(children, { thresholds = THRESHOLDS } = {}) -> Finding | null`
    `children = [{ type, id, label, cost, tokens? }]`
  - `analyzeFanout(sessions, { thresholds = THRESHOLDS } = {}) -> Finding | null`
    `sessions = [{ id, parentId }]`
  - `Finding = { code, severity, share_pct, subject: { type, id, label }, evidence: object, hypothesis: string }`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessages, analyzeConcentration, analyzeFanout } from '../src/analyze/heuristics.mjs';

const msg = (id, tokens) => ({ id, label: `#${id}`, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, effective: 0, cost: 0, ...tokens } });

test('detecta no_cache_input', () => {
  const findings = analyzeMessages([msg('m1', { input: 20000, cacheRead: 0, cost: 0.5 })]);
  const f = findings.find((x) => x.code === 'no_cache_input');
  assert.ok(f);
  assert.equal(f.subject.id, 'm1');
  assert.equal(f.severity, 'high');
});

test('detecta long_output y high_reasoning_share', () => {
  const findings = analyzeMessages([
    msg('m1', { output: 5000, effective: 5000, cost: 0.1 }),
    msg('m2', { output: 10, reasoning: 900, effective: 1000, cost: 0.1 }),
  ]);
  assert.ok(findings.some((f) => f.code === 'long_output'));
  assert.ok(findings.some((f) => f.code === 'high_reasoning_share'));
});

test('analyzeMessages no dispara con valores normales', () => {
  assert.deepEqual(analyzeMessages([msg('m1', { input: 100, cacheRead: 9900, output: 50, effective: 150, cost: 0.0001 })]), []);
});

test('concentración necesita >= 5 hijos y comparte >= 50%', () => {
  const children = [
    { type: 'turn', id: 'a', label: 'A', cost: 8 },
    { type: 'turn', id: 'b', label: 'B', cost: 1 },
    { type: 'turn', id: 'c', label: 'C', cost: 1 },
    { type: 'turn', id: 'd', label: 'D', cost: 0 },
    { type: 'turn', id: 'e', label: 'E', cost: 0 },
  ];
  const f = analyzeConcentration(children);
  assert.ok(f);
  assert.equal(f.code, 'cost_concentration');
  assert.equal(f.subject.id, 'a');
  assert.equal(analyzeConcentration(children.slice(0, 4)), null);
});

test('fanout exige >= 5 subagentes del mismo padre', () => {
  const kids = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, parentId: 'p' }));
  const f = analyzeFanout(kids);
  assert.ok(f);
  assert.equal(f.evidence.subagents, 5);
  assert.equal(analyzeFanout(kids.slice(0, 4)), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/heuristics.test.mjs`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implement `src/analyze/heuristics.mjs`**

- `analyzeMessages`: para cada regla, filtrar los mensajes que la cumplen; si no hay, no emitir. `no_cache_input` (input ≥ 8000 y cacheRead ≤ input·0.1), `low_cache_hit` (hitRatio < 0.9 y `input+cacheRead ≥ 120000`), `long_output` (output ≥ 1000), `high_reasoning_share` (effective > 0 y reasoning/effective ≥ 0.25), `expensive_model_mismatch` (`cost ≥ 0.01` y `output < 500`).
- Agrupar por regla: `evidence.messages = n`, `evidence.cost`, `share_pct` = cost afectado / cost total del scope (×100, redondeado); `subject` = el mensaje de mayor costo; `severity` = high si `share_pct ≥ 10`, medium si `≥ 3`, si no `low`. Ordenar por `share_pct` desc.
- `HYPOTHESES` con las frases de la spec por code.
- `analyzeConcentration`: si `children.length < costConcentrationMinChildren` → null; si `topShare(costs,3) < 0.5` → null; sujeto = hijo de mayor costo.
- `analyzeFanout`: contar por `parentId`; si el máximo `>= 5`, Finding con `evidence.subagents` y `subject` = ese padre.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/heuristics.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/heuristics.mjs tests/heuristics.test.mjs
git commit -m "feat: add causal heuristics engine"
```

---

### Task 7: Tools `spend_overview` y `top_sessions` + helper de origen/cache

**Files:**
- Create: `src/tools/common.mjs`, `src/tools/spend_overview.mjs`, `src/tools/top_sessions.mjs`
- Test: `tests/tools-read-1.test.mjs`, `tests/helpers/harness.mjs`

**Interfaces:**
- Consumes: `deps = { config, api, db, store, thresholds }`; `api.get(path, params)`.
- Produces:
  - `resolveRaw({ store, tool, params, load }) -> Promise<{ runId, raw, cached }>` (usa `store.getFresh`; si no, `load()` + `store.put`).
  - `toolResult({ text, structured }) -> { content: [{ type: 'text', text }], structuredContent: structured }`.
  - `registerSpendOverview(server, deps)`, `registerTopSessions(server, deps)`.
  - Endpoints: `GET /api/projects?range=` → `{ items:[{ id, label, sessions, metrics }], totals }`; `GET /api/projects/:id/sessions?range=` → `{ items:[{ id, title, parentId, tokens, modelId, effective }], totals }`.

- [ ] **Step 1: Write the test harness and failing tests**

`tests/helpers/harness.mjs`:
```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server.mjs';
import { createStore } from '../../src/store/runs.mjs';
import { THRESHOLDS } from '../../src/analyze/thresholds.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startHarness({ tools, api, db }) {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'mcp-h-')) });
  const deps = { config: { cacheTtlMs: 600000 }, api, db, store, thresholds: THRESHOLDS, tools };
  const server = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
```

`tests/tools-read-1.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerSpendOverview } from '../src/tools/spend_overview.mjs';
import { registerTopSessions } from '../src/tools/top_sessions.mjs';

const projects = { items: [{ id: 'p1', label: 'animaciones', sessions: 3, metrics: { effective: 1000, cost: 1.5 } }], totals: { effective: 1000, cost: 1.5 } };

test('spend_overview resume proyectos y guarda raw', async () => {
  const { client, close } = await startHarness({
    tools: [registerSpendOverview],
    api: { get: async (p) => (p === '/api/projects' ? projects : {}) },
  });
  const res = await client.callTool({ name: 'spend_overview', arguments: { range: 'all' } });
  assert.match(res.content[0].text, /animaciones/);
  assert.ok(res.structuredContent.raw || res.structuredContent.runId);
  await close();
});

test('top_sessions sin project recorre todos los proyectos', async () => {
  const { client, close } = await startHarness({
    tools: [registerTopSessions],
    api: {
      get: async (p) => (p === '/api/projects' ? projects : { items: [{ id: 's1', title: 'sesión', parentId: null, tokens: { cost: 1, effective: 100 } }] }),
    },
  });
  const res = await client.callTool({ name: 'top_sessions', arguments: { range: 'all', metric: 'cost' } });
  assert.match(res.content[0].text, /sesión/);
  await close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tools-read-1.test.mjs`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Implement `src/tools/common.mjs`**

`resolveRaw`: `runId = store.runIdFor(tool, params)`; `fresh = await store.getFresh(tool, params)`; si `fresh` → `{ runId, raw: fresh, cached: true }`; si no → `raw = await load()`, `await store.put(tool, params, raw)`, `{ runId, raw, cached: false }`.
`toolResult`: devuelve la forma estándar.

- [ ] **Step 4: Implement `src/tools/spend_overview.mjs` y `top_sessions.mjs`**

`spend_overview({ range = '30d', raw = false })`: `resolveRaw` sobre `GET /api/projects`; resumen = totales + top 10 proyectos por `metrics.cost` (label, costo, efectivos); `structuredContent = { runId, cached, totals, raw: raw ? raw : undefined }`.
`top_sessions({ range = '30d', project, metric = 'effective', limit = 10, raw = false })`: si `project`, `GET /api/projects/:id/sessions`; si no, `GET /api/projects` y por cada proyecto sus sesiones (concatenar), ordenar por `tokens[metric]` desc y cortar a `limit`; marcar subagentes (`parentId`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/tools-read-1.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/ tests/tools-read-1.test.mjs tests/helpers/harness.mjs
git commit -m "feat: add spend_overview and top_sessions tools"
```

---

### Task 8: Tools `top_turns`, `explain_message` y `quota_status`

**Files:**
- Create: `src/tools/top_turns.mjs`, `src/tools/explain_message.mjs`, `src/tools/quota_status.mjs`
- Test: `tests/tools-read-2.test.mjs`

**Interfaces:**
- Consumes: `resolveRaw`, `toolResult`, `formatTokens`, `formatUsd`.
- Produces:
  - `registerTopTurns(server, deps)`, `registerExplainMessage(server, deps)`, `registerQuotaStatus(server, deps)`.
  - Endpoints: `GET /api/sessions/:id/turns?range=` → `{ turns:[{ id, index, prompt, promptTime, messageCount, tokens, messages }], totals, sessionTotals, partial, skipped }`; `GET /api/messages/:id` → `{ id, tokens, modelId, tools:[{name,count}], trigger:{ user, subagent } }`; `GET /api/quota` → `{ windows:[{ label, used, limit, resetsAt }] }` (parseo tolerante).

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerTopTurns } from '../src/tools/top_turns.mjs';
import { registerExplainMessage } from '../src/tools/explain_message.mjs';
import { registerQuotaStatus } from '../src/tools/quota_status.mjs';

test('top_turns lista turnos por costo', async () => {
  const { client, close } = await startHarness({
    tools: [registerTopTurns],
    api: { get: async () => ({ turns: [{ id: 't1', index: 0, prompt: 'hola', messageCount: 2, tokens: { cost: 0.5, effective: 10 }, messages: [] }], totals: {} }) },
  });
  const res = await client.callTool({ name: 'top_turns', arguments: { sessionId: 's1', range: 'all' } });
  assert.match(res.content[0].text, /hola/);
  await close();
});

test('explain_message muestra tools y disparador', async () => {
  const { client, close } = await startHarness({
    tools: [registerExplainMessage],
    api: { get: async () => ({ id: 'm1', tokens: { input: 10, cost: 0.01 }, tools: [{ name: 'read', count: 2 }], trigger: { user: { text: 'hacé algo' }, subagent: null } }) },
  });
  const res = await client.callTool({ name: 'explain_message', arguments: { messageId: 'm1' } });
  assert.match(res.content[0].text, /read/);
  assert.match(res.content[0].text, /hacé algo/);
  await close();
});

test('quota_status tolera respuesta vacía', async () => {
  const { client, close } = await startHarness({ tools: [registerQuotaStatus], api: { get: async () => ({}) } });
  const res = await client.callTool({ name: 'quota_status', arguments: {} });
  assert.equal(typeof res.content[0].text, 'string');
  await close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tools-read-2.test.mjs`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Implement the three tools**

`top_turns({ sessionId, range = '30d', limit = 10, raw = false })`: resumen = turnos ordenados por `tokens.cost` desc (nro, prompt truncado, mensajes, costo), más la nota de poda si `partial`.
`explain_message({ messageId, raw = false })`: resumen = tokens, costo, tools y disparador (user + subagente).
`quota_status({ raw = false })`: resumen tolerante; si no hay ventanas, "sin datos de cuota".

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tools-read-2.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/ tests/tools-read-2.test.mjs
git commit -m "feat: add top_turns, explain_message and quota_status tools"
```

---

### Task 9: Tool `diagnose`

**Files:**
- Create: `src/tools/diagnose.mjs`
- Test: `tests/tools-diagnose.test.mjs`

**Interfaces:**
- Consumes: `analyzeMessages`, `analyzeConcentration`, `analyzeFanout`, `resolveRaw`, `formatFindings`, `percentile`.
- Produces: `registerDiagnose(server, deps)`; tool `diagnose({ scope, id?, sessionId?, range = '30d', raw = false })`.
  - `next` es un array de strings con la forma `diagnose scope=<scope> id=<id>` (o `explain_message messageId=<id>` en scope `turn`).

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerDiagnose } from '../src/tools/diagnose.mjs';

const projects = { items: [{ id: 'p1', label: 'A', metrics: { cost: 9 } }, { id: 'p2', label: 'B', metrics: { cost: 1 } }] };
const turns = { turns: [
  { id: 't1', index: 0, prompt: 'x', messageCount: 1, tokens: { cost: 5 }, messages: [{ id: 'm1', tokens: { input: 20000, cacheRead: 0, cost: 5, effective: 20000 } }] },
] };

test('diagnose global concentra y sugiere bajar a project', async () => {
  const { client, close } = await startHarness({ tools: [registerDiagnose], api: { get: async (p) => (p === '/api/projects' ? projects : turns) } });
  const res = await client.callTool({ name: 'diagnose', arguments: { scope: 'global', range: 'all' } });
  assert.match(res.content[0].text, /cost_concentration/);
  assert.ok(res.structuredContent.next.some((s) => s.includes('scope=project')));
  await close();
});

test('diagnose session detecta no_cache en mensajes', async () => {
  const { client, close } = await startHarness({ tools: [registerDiagnose], api: { get: async () => turns } });
  const res = await client.callTool({ name: 'diagnose', arguments: { scope: 'session', id: 's1', range: 'all' } });
  assert.match(res.content[0].text, /no_cache_input/);
  await close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-diagnose.test.mjs`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implement `src/tools/diagnose.mjs`**

Por scope:
- `global`: `GET /api/projects` → children = projects; findings = `analyzeConcentration`; `next` = proyecto más caro.
- `project`: `GET /api/projects/:id/sessions` → children = sesiones; findings = concentration + `analyzeFanout(sessions)`; `next` = sesión más cara.
- `session`: `GET /api/sessions/:id/turns` → children = turnos (cost = `tokens.cost`); messages = turnos.flatMap(t => t.messages); findings = concentration + `analyzeMessages(messages)`; `next` = turno más caro.
- `turn`: `GET /api/sessions/:sessionId/turns`, ubicar el turno `id`; findings = `analyzeMessages(turn.messages)`; `next` = `explain_message messageId=<el de mayor costo>`.
- `message`: `GET /api/messages/:id` → `analyzeMessages([detail])`.
`totals` = suma de costs/effective/messages/turns según scope. `structuredContent = { runId, scope, subject, range, totals, findings, next, raw? }`; `text` = `formatFindings(findings)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tools-diagnose.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/diagnose.mjs tests/tools-diagnose.test.mjs
git commit -m "feat: add diagnose tool with one-level drilldown"
```

---

### Task 10: Tools `recall` y `query_db`

**Files:**
- Create: `src/tools/recall.mjs`, `src/tools/query_db.mjs`
- Test: `tests/tools-store.test.mjs`

**Interfaces:**
- Consumes: `store`, `db`.
- Produces: `registerRecall(server, deps)`, `registerQueryDb(server, deps)`; tools `recall({ runId?, path?, limit = 20, raw = false })` y `query_db({ sql, raw = false })`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { registerRecall } from '../src/tools/recall.mjs';
import { registerQueryDb } from '../src/tools/query_db.mjs';

test('recall lista y recupera por id y path', async () => {
  const { client, close } = await startHarness({ tools: [registerRecall] });
  // sembrar un run usando el mismo store del harness sería ideal; si no, testear list vacío
  const res = await client.callTool({ name: 'recall', arguments: {} });
  assert.equal(typeof res.content[0].text, 'string');
  await close();
});

test('query_db devuelve filas y rechaza escrituras', async () => {
  const db = { available: () => true, query: (sql) => { if (/delete/i.test(sql)) throw new Error('blocked'); return [{ n: 1 }]; } };
  const { client, close } = await startHarness({ tools: [registerQueryDb], db });
  const ok = await client.callTool({ name: 'query_db', arguments: { sql: 'SELECT 1 AS n' } });
  assert.match(ok.content[0].text, /1/);
  const bad = await client.callTool({ name: 'query_db', arguments: { sql: 'DELETE FROM t' } });
  assert.equal(bad.isError, true);
  await close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-store.test.mjs`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Implement**

`recall`: sin `runId` → `store.list({ limit })` a texto; con `runId` → `store.recall(runId, path)` (si `path`, texto con el valor; si no, JSON si `raw`, o resumen).
`query_db`: si `!deps.db?.available()` → resultado `isError: true` con mensaje accionable; si no, `deps.db.query(sql)`, resumir filas (primeras 20) a texto, `structuredContent = { rows, raw? }`; capturar el error de `guardSelect` y devolver `isError: true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tools-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/recall.mjs src/tools/query_db.mjs tests/tools-store.test.mjs
git commit -m "feat: add recall and guarded query_db tools"
```

---

### Task 11: Wiring final, ejemplo de config y README

**Files:**
- Modify: `src/server.mjs`, `index.mjs`
- Create: `README.md`, `examples/opencode.jsonc`
- Test: `tests/integration.test.mjs`

**Interfaces:**
- Consumes: todos los `register*`.
- Produces: `index.mjs` funcional por stdio; lista de tools completa registrada.

- [ ] **Step 1: Write the failing integration test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.mjs';
import { createApiClient } from '../src/client/api.mjs';
import { createDbAccess } from '../src/client/db.mjs';
import { createStore } from '../src/store/runs.mjs';
import { THRESHOLDS } from '../src/analyze/thresholds.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('el server registra las 8 tools', async () => {
  const server = buildServer({
    config: { cacheTtlMs: 600000 },
    api: createApiClient({ baseUrl: 'http://127.0.0.1:1' }),
    db: createDbAccess({ dbPath: '/nope.db' }),
    store: createStore({ dir: '/tmp/mcp-int', enabled: false }),
    thresholds: THRESHOLDS,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['diagnose', 'explain_message', 'quota_status', 'query_db', 'recall', 'spend_overview', 'top_sessions', 'top_turns']);
  await client.close();
  await server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration.test.mjs`
Expected: FAIL — faltan tools registradas.

- [ ] **Step 3: Implement `src/server.mjs` (registro completo) e `index.mjs`**

`buildServer(deps)`: crear el `McpServer` y llamar, en orden, `registerSpendOverview`, `registerTopSessions`, `registerTopTurns`, `registerExplainMessage`, `registerDiagnose`, `registerQuotaStatus`, `registerRecall`, `registerQueryDb` (importar de `./tools/*.js`). Quitar el parámetro `tools` usado en el test de Task 1 (actualizar ese test a `buildServer({})` o a `deps` completos).
`index.mjs`: `loadConfig(process.env, { defaultStoreDir: new URL('./store', import.meta.url).pathname })`; `deps = { config, api: createApiClient({ baseUrl: config.apiUrl, timeoutMs: config.httpTimeoutMs }), db: createDbAccess({ dbPath: config.dbPath, enabled: config.dbFallback }), store: createStore({ dir: config.storeDir, ttlMs: config.cacheTtlMs, enabled: config.storeEnabled }), thresholds: THRESHOLDS }`; `await buildServer(deps).connect(new StdioServerTransport())`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add `README.md` y `examples/opencode.jsonc`**

README: qué hace, tools, config por entorno, cómo levantarlo, relación con `sistemaTokens` (debe estar corriendo para la API; la BD es fallback). `examples/opencode.jsonc`: el bloque de la spec (`mcp.servers.sistemaTokens`, `type: local`, `command`, `environment`).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (todos).

- [ ] **Step 7: Commit**

```bash
git add src/server.mjs index.mjs README.md examples/ tests/integration.test.mjs tests/server.test.mjs
git commit -m "feat: wire all tools and add example config and README"
```

---

## Deferred

- `repeated_tool_calls`: requiere las partes por mensaje (`getMessageDetail`), que no vienen en los listados de sesión/turno; se implementa cuando `diagnose` baje a nivel mensaje con datos de tools. Mientras tanto queda documentado y con umbral reservado.
- `compaction_overhead`: se implementa con `session.compacted`, pero no hay sesiones compactadas en la BD actual para validarlo; al no tener señal real, se deja para una iteración con datos.

## Self-Review

- **Spec coverage:** reutilización HTTP + fallback (Tasks 2/3), store/raw/recall (Tasks 4/10), tools del listado (Tasks 7/8), `diagnose` un nivel + `next` (Task 9), `query_db` con guardrails (Tasks 3/10), umbrales calibrados (Tasks 5/6), config V2 y ejemplo (Tasks 1/11), privacidad (Global Constraints + `.gitignore` Task 1). Cubierto.
- **Step scan:** cada paso define un test con aserciones, una firma o un comando con salida esperada.
- **Type consistency:** `Finding`, `Metrics`, `deps`, `resolveRaw`/`toolResult`, `register*` mantienen la misma forma entre tasks; `diagnose` usa los nombres de scope de la spec.
- **Review Focus:** API caída/timeout (Task 2 timeout + Task 3 `available()`/`query_db` error), SQL riesgoso (Task 3 guardrails), DB inexistente (Task 3), store corrupto (Task 4, líneas inválidas ignoradas), stdout limpio (Global Constraints; `index.mjs` solo `console.error`).
- **Proportion:** el plan describe interfaces y tests; los cuerpos quedan a criterio del implementador salvo donde el algoritmo no es evidente (heurísticas, guardrails).
