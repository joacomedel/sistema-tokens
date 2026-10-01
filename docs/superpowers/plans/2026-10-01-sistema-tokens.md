# sistemaTokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App web local (Node 24 puro) que lee la BD SQLite de OpenCode en solo-lectura y permite navegar proyecto → sesión → mensaje con barras, señales de causa y panel de cuota.

**Architecture:** Proceso único `server.mjs` (HTTP + API JSON) + módulos `lib/` (ranges, db, causes, quota) + frontend vanilla con μPlot vendorizado. Cero dependencias npm. Cálculos en backend; el frontend solo pinta.

**Tech Stack:** Node ≥ 24 (`node:sqlite`, `node:http`, `fetch` nativos), HTML/CSS/JS vanilla, μPlot 1.6.x (vendor local), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-sistema-tokens-design.md`

## Global Constraints

- Node ≥ 24.0. Scripts con `--disable-warning=ExperimentalWarning`.
- **Cero dependencias npm** (`dependencies` y `devDependencies` vacíos). μPlot vendorizado en `public/vendor/`.
- Servidor solo en `127.0.0.1`, puerto default `4747` (configurable; tests usan puerto `0`).
- **Solo lectura de `opencode.db`** (`readOnly: true`); ninguna sentencia de escritura.
- Tokens/credenciales: nunca se loguean ni se envían al frontend.
- Textos de UI en español rioplatense; código, nombres y commits en inglés.
- Rango default `30d`; métrica default `effective` (tokens efectivos = input+output+reasoning).
- Tests construyen fechas con el constructor local (`new Date(y, m, d, h)`) para no depender de `TZ`.

## Review Focus

| # | Input/condición no cubierta explícitamente por la spec | Comportamiento esperado | Test en |
|---|---|---|---|
| 1 | `opencode.db` ausente o ruta custom (`XDG_DATA_HOME`) | Error claro (`BD no encontrada en <path>`), sin crash | Task 2 y Task 6 |
| 2 | JSON no-parseable o campos faltantes en `message.data`/`part.data` | Se saltea el ítem, contador `skipped`, el resto funciona | Task 3 |
| 3 | Rango sin datos (p. ej. `today` sin actividad) | `items: []`, totales en 0, estado vacío legible | Task 6 y Task 7 |
| 4 | Modelos gratuitos (`cost = 0`) y tokens enormes/0 | `0` se muestra como `$0.00` legítimo; nunca `NaN`/`undefined` | Task 3 y Task 4 |
| 5 | `/api/quota` con respuesta HTML (Cloudflare 403) o shapes raros | Parseo tolerante, nunca `TypeError`; cae a local con causa | Task 5 |

---

### Task 1: Scaffolding + `lib/ranges.mjs`

**Files:**
- Create: `package.json`, `config.json`, `lib/ranges.mjs`
- Test: `tests/ranges.test.mjs`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `RANGES = ['today','7d','30d','month','all']`
  - `resolveRange(key, now = new Date()) -> { key, fromMs: number|null, toMs: number|null, label: string }`
  - `config.json`: `{ "port": 4747, "dbPath": null, "quota": { "ttlSeconds": 60, "manualLimits": { "rolling": null, "weekly": null, "monthly": null } } }` (`dbPath: null` → default XDG/`~/.local/share`)

Semántica de rangos (local time): `today` = desde medianoche local de `now`; `7d` = `now - 7*86400000`; `30d` = `now - 30*86400000`; `month` = primer día del mes de `now` a las 00:00; `all` = `null/null`. `toMs` = `now.getTime()` (excepto `all`). Labels: `Hoy`, `Últimos 7 días`, `Últimos 30 días`, `Este mes`, `Todo`.

- [ ] **Step 1: Write the failing test**

`tests/ranges.test.mjs` con `now = new Date(2026, 9, 1, 12, 0, 0)` (1-oct-2026 12:00 local):
- `resolveRange('today', now).fromMs === new Date(2026, 9, 1).getTime()`
- `resolveRange('7d', now).fromMs === now.getTime() - 7*86400000`
- `resolveRange('month', now).fromMs === new Date(2026, 9, 1).getTime()`
- `resolveRange('all', now)` → `{ fromMs: null, toMs: null }`
- `toMs === now.getTime()` en los no-`all`; key/label presentes; `resolveRange('nope')` tira `Error`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ranges.test.mjs`
Expected: FAIL (`Cannot find module '../lib/ranges.mjs'`)

- [ ] **Step 3: Implement**

Crear `package.json` (`"type": "module"`, scripts: `start` → `node --disable-warning=ExperimentalWarning server.mjs`, `test` → `node --test tests/`, `verify` → `node scripts/verify.mjs`; sin dependencias), `config.json` (arriba) y `lib/ranges.mjs` según las firmas.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ranges.test.mjs` → PASS

- [ ] **Step 5: Commit**

```bash
git add package.json config.json lib/ranges.mjs tests/ranges.test.mjs
git commit -m "feat: scaffolding and time ranges"
```

---

### Task 2: Fixture de tests + `lib/db.mjs` (niveles 1 y 2)

**Files:**
- Create: `lib/db.mjs`, `tests/helpers/fixture.mjs`
- Test: `tests/db-projects.test.mjs`

**Interfaces:**
- Consumes: nada de tasks previas (independiente).
- Produces:
  - `openDb(dbPath) -> DatabaseSync` — readonly, retry 3×100 ms; si no existe tira `Error('BD no encontrada en <path>')`.
  - `listProjects(db, { fromMs, toMs }) -> { items: ProjectItem[], totals: Metrics }`
  - `listSessions(db, { projectId = null, fromMs, toMs }) -> { items: SessionItem[], totals: Metrics }`
  - `Metrics = { input, output, reasoning, cacheRead, cacheWrite, total, effective, cost }` (`effective = input+output+reasoning`)
  - `ProjectItem = { id, label, worktree, sessions, metrics, flagsSummary: { sessionsWithSignals } }` — `flagsSummary` lo llena Task 6 con `summarizeFlags`; hasta entonces `{ sessionsWithSignals: 0 }`.
  - `SessionItem = { id, projectId, parentId, title, directory, modelId, providerId, variant, effective, tokens, compacted, timeCreated, timeUpdated, flags: [] }` (flags los llena Task 4)
  - Label de proyecto: `name ?? basename(worktree)`; worktree `/` → `Global`.

Fixture (`tests/helpers/fixture.mjs` → `makeFixtureDb(filePath)`): esquema mínimo (`project`, `session_v2`, `message`, `part`) y datos exactos:
- P1 `worktree=/home/u/proj-a`; P2 `worktree=/`
- S1 raíz de P1, S2 hija de S1 (`parent_id`), S3 de P2
- M1 (S1): input 100, output 50, reasoning 10, cache.read 1000, cost 0.01
- M2 (S1): input 200, output 20, reasoning 0, cache.read 0, cache.write 5, cost 0.02
- M3 (S2): input 50, output 10, reasoning 5, cache.read 500, cost 0.005
- M4 (S3): input 10, output 5, reasoning 0, cache 0, cost 0
- Times: M1 en `2026-10-01T10:00 local`, M2 en `12:00`, M3 en `13:00`, M4 en `14:00` (usar constructor local). `session_v2.model` como JSON string.

Valores esperados: S1 → effective 380 (160+220); S2 → 65; P1 → sesiones 2, effective 445, cost 0.035; P2 → effective 15, cost 0.

- [ ] **Step 1: Write the failing test** (`tests/db-projects.test.mjs`)

Crear fixture en `os.tmpdir()`; asserts:
- `listProjects(db, {fromMs: new Date(2026,9,1).getTime(), toMs: new Date(2026,9,2).getTime()})` → 2 items; P1 `label === 'proj-a'`, `sessions === 2`, `metrics.effective === 445`, `metrics.cost` ≈ 0.035; P2 `label === 'Global'`, `effective === 15`, `cost === 0`.
- `listSessions(db, {projectId: P1, ...})` → 2 items; S2 `parentId === S1.id`; S1 `tokens.effective === 380`.
- Rango que excluye todo (`fromMs` en 2027) → `items: []`, `totals.effective === 0`.
- `openDb('/no/existe.db')` tira `Error` con `BD no encontrada`.
- Sesión con `title` null → `title === ''`.

- [ ] **Step 2: Run test to verify it fails** → `Cannot find module '../lib/db.mjs'`

- [ ] **Step 3: Implement `lib/db.mjs`**

SQL con `json_extract(m.data, '$.role')='assistant'` y `m.time_created BETWEEN ? AND ?` (si `fromMs === null` → sin cláusula de rango). Agregaciones: `SUM(json_extract(...))`. `countDistinct sessions`. Round de cost a 6 decimales con `Math.round(x*1e6)/1e6` para evitar floats raros.

- [ ] **Step 4: Run tests** → `node --test tests/` PASS

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/helpers/fixture.mjs tests/db-projects.test.mjs
git commit -m "feat: projects and sessions queries with readonly sqlite"
```

---

### Task 3: `lib/db.mjs` — nivel 3 y detalle

**Files:**
- Modify: `lib/db.mjs`
- Test: `tests/db-messages.test.mjs`

**Interfaces:**
- Consumes: `openDb` (Task 2).
- Produces:
  - `listMessages(db, sessionId, { fromMs, toMs }) -> { items: MessageItem[], skipped: number }`
  - `MessageItem = { id, timeCreated, durationMs: number|null, modelId, providerId, variant, agent, tokens: Metrics, flags: [] }` (flags los llena Task 4)
  - `getMessageDetail(db, messageId) -> MessageDetail | null`
  - `MessageDetail = MessageItem & { tools: [{ name, count }] }`
- `skipped`: mensajes assistant cuyo `data` no parsea o no tiene `tokens`.

- [ ] **Step 1: Write the failing test**

Fixture de Task 2 +
- mensaje corrupto en S1: `data = 'no-json{'` (rol desconocido) y mensaje sin `tokens` → `skipped === 2`, `items.length` solo con los válidos.
- M1: `tokens.effective === 160`, `tokens.cacheRead === 1000`, `durationMs === 5000` (si en fixture `time.completed = created + 5000`), `modelId` correcto.
- M2 sin `time.completed` → `durationMs === null`.
- `getMessageDetail(M1.id)` → `tools` con `[{name:'read', count:2},{name:'bash',count:1}]` (insertar 3 `part` type `tool` en fixture para M1: 2 `read`, 1 `bash`); parte con `data` corrupto → se ignora, no rompe.
- `getMessageDetail('nope')` → `null`.

- [ ] **Step 2: Run → FAIL**; **Step 3: Implement**; **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db-messages.test.mjs
git commit -m "feat: messages and detail queries"
```

---

### Task 4: `lib/causes.mjs` — señales de causa

**Files:**
- Create: `lib/causes.mjs`
- Test: `tests/causes.test.mjs`

**Interfaces:**
- Consumes: los shapes de Task 2 y 3.
- Produces:
  - `percentile(values, p) -> number` — nearest-rank: ordena ascendente, `idx = clamp(ceil(p*n)-1, 0, n-1)`. P.ej. `percentile([1..10], 0.9) === 9`, `percentile([1..10], 0.75) === 8`.
  - `annotateMessages(items) -> void` — muta cada ítem agregando `flags: Flag[]`.
  - `annotateSessions(items, { childCounts }) -> void` — `childCounts: Map<sessionId, number>`; muta con `flags`.
  - `summarizeFlags(sessionItems) -> { sessionsWithSignals: number }`
  - `Flag = { code, label, severity }` con codes/labels: `no_cache`/"contexto sin cache", `long_output`/"output largo", `expensive_model`/"modelo caro", `high_reasoning`/"razonamiento alto", `compacted`/"se compactó", `many_subagents`/"muchos subagentes".
- Reglas (set visible; `effective = tokens.effective`):
  - `no_cache`: `cacheRead === 0 && input >= percentile(inputs, .75)`
  - `long_output`: `output >= percentile(outputs, .9)`
  - `high_reasoning`: `reasoning > 0 && reasoning >= percentile(reasonings, .9)`
  - `expensive_model`: `effective > 0 && cost/effective >= 2*median` y `n >= 5`
  - `compacted` (sesiones): `compacted === true`
  - `many_subagents` (sesiones): `childCounts.get(id) >= 5`
  - Prioridad al recortar: `no_cache > expensive_model > long_output > high_reasoning` (sesiones además `compacted > many_subagents`). **Máximo 2 flags por ítem**; `severity` = índice de prioridad.

- [ ] **Step 1: Write the failing test**

- Percentiles exactos de arriba.
- Mensajes `[A..E]` con valores construidos para que: A → `no_cache`, B → `long_output`, C → `high_reasoning`, D sanitario sin flags; `assertEquals` de `flags.map(f=>f.code)` por ítem.
- `expensive_model` solo con `n >= 5` y `cost/effective` exactamente `>= 2*median` (usar números redondos: costs `[1,1,1,1,10]` y `effective=1` cada uno → mediana 1 → el 5º flag; con `n=4` y 2× mediana exacto NO se marca si no supera… cubrir borde `= 2*median` → sí marca).
- Recorte: ítem que dispara 3 señales queda con las 2 de mayor prioridad.
- Sesiones: `compacted: true` → flag; `childCounts` 5 → `many_subagents`; `childCounts` 4 → no.
- `summarizeFlags`: 2 de 3 sesiones con flags → `{ sessionsWithSignals: 2 }`.
- Casos borde: set vacío → no throw; todos `cost = 0` (modelos free) → nadie marcado como caro; `effective = 0` con cost > 0 → se saltea (no división por cero, no `NaN`).

- [ ] **Step 2 → 4:** FAIL → implement → PASS (`node --test tests/causes.test.mjs`)

- [ ] **Step 5: Commit**

```bash
git add lib/causes.mjs tests/causes.test.mjs
git commit -m "feat: cause signals and outliers"
```

---

### Task 5: `lib/quota.mjs` — cuotas con fallback

**Files:**
- Create: `lib/quota.mjs`
- Test: `tests/quota.test.mjs`

**Interfaces:**
- Consumes: `openDb` (Task 2) para el fallback local.
- Produces:
  - `parseUsagePayload(payload) -> QuotaWindow[]` — tolera `percent|percentage`, `resetsAt|resetAt|reset_at` (ISO o epoch-ms); ignora ventanas desconocidas sin `percent`; devuelve en orden `rolling, weekly, monthly`; ventana conocida presente pero sin datos → `percent: null`.
  - `getQuota({ db, fetchImpl, now = new Date(), ttlSeconds = 60, cache = null }) -> QuotaResult`
  - `QuotaResult = { source: 'api'|'local', error: string|null, fetchedAt: number, windows: [{ id, label, percent: number|null, resetsAt: string|null, usedUsd: number|null }] }`
  - `QuotaWindow = { id: 'rolling'|'weekly'|'monthly', label, percent, resetsAt }` (labels: `5 horas`, `Semanal`, `Mensual`)
  - `localWindows(db, { now, manualLimits = null }) -> windows[]` — ventanas: `rolling` = últimas 5 h; `weekly` = lunes 00:00 local; `monthly` = día 1 00:00; `usedUsd` = suma de cost de mensajes en la ventana; `percent` = `usedUsd/límite*100` redondeado si hay límite manual, si no `null`.
- Estrategia API: intentar credenciales en orden `SELECT value FROM credential LIMIT 1` (Bearer) → `SELECT access_token FROM account LIMIT 1` (Bearer); URL `https://opencode.ai/zen/go/v1/usage`, header `Accept: application/json`; timeout 10 s; si existe `cache` con `fetchedAt + ttlSeconds*1000 > now` → devuelve cache sin fetch. Cualquier fallo (status ≠ 200, HTML, red, JSON inválido) → `localWindows` con `source: 'local'` y `error` legible (`401 Unauthorized`, `red: <mensaje>`, etc.). Los tokens **nunca** aparecen en `error` ni se loguean.

- [ ] **Step 1: Write the failing test**

- `parseUsagePayload` con payload real de pi-usage (`rolling.percent=10`, `weekly.percent="5"`, `monthly` con `reset_at` epoch-ms) → 3 ventanas en orden con valores correctos.
- Payload `{usage:{}}`, `{}`, `null`, `'<html>403</html>'` → `[]` sin throw.
- `getQuota` con `fetchImpl` fake: caso 1 (credential 200) → `source:'api'`; caso 2 (credential 401, account 200) → `api`; caso 3 (ambas 401) → `local`, `error` incluye `401`; caso 4 (fetch tira `Error('red caída')`) → `local` con `red:`.
- Caché: 2 llamadas seguidas con fake que cuenta invocaciones → 1 sola llamada a `fetchImpl`.
- `localWindows` con fixture (mensajes M1–M4, `now` = 2026-10-01 23:00 local): `monthly.usedUsd === 0.035`; `manualLimits.monthly = 0.07` → `percent === 50`.

- [ ] **Step 2 → 4:** FAIL → implement → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/quota.mjs tests/quota.test.mjs
git commit -m "feat: quota via api with local fallback"
```

---

### Task 6: `server.mjs` — API HTTP

**Files:**
- Create: `server.mjs`
- Test: `tests/server.test.mjs`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `createServer({ dbPath, config = {}, quotaFetcher = null }) -> { server, close }` — `quotaFetcher` inyectable para tests (default: `getQuota` con la BD real).
  - Rutas:
    - `GET /api/meta` → `{ range: '30d', db: { ok, path }, quota: { source, error, fetchedAt } }`
    - `GET /api/projects?range=` → `{ range, items, totals }` (con `flagsSummary` real vía `listSessions` + `annotateSessions` + `summarizeFlags`)
    - `GET /api/projects/:id/sessions?range=` → `{ range, items, totals }` (flags vía `annotateSessions` con `childCounts` internos)
    - `GET /api/sessions/:id/messages?range=` → `{ range, items, skipped, totals }` (flags vía `annotateMessages`)
    - `GET /api/messages/:id` → `MessageDetail` (404 JSON si no existe)
    - `GET /api/quota?refresh=1` → `QuotaResult`
    - Estáticos: `/` → `public/index.html`; `/app.js`, `/styles.css`, `/vendor/*`; content-types correctos; sin path traversal.
  - Errores: `{ error: { code, message } }` con status 400 (range inválido), 404, 500 (BD rota); `dbPath` default desde `config.json`/XDG.
- El servidor **nunca** expone tokens de cuota en las respuestas.

- [ ] **Step 1: Write the failing test** (`tests/server.test.mjs` con `listen(0)` y `fetch` a `127.0.0.1:${port}`)

- Con fixture y `quotaFetcher` fake: `/api/projects?range=all` → 200, P1 presente con `metrics.effective === 445`, `flagsSummary.sessionsWithSignals` es número; `/api/projects?range=xxx` → 400 JSON de error; `/api/sessions/:id/messages` → `skipped >= 0`; rango sin datos → `items: []`, `totals.effective === 0`; `/api/messages/:id` existe → `tools` array; inexistente → 404 JSON; `/api/quota` → `source` fake; `GET /` → 200 `text/html` con `<div id="app">`; `GET /../etc/passwd` → 404. `close()` limpia.
- BD inexistente → `/api/meta` responde `db.ok === false` y `/api/projects` responde 500 con mensaje `BD no encontrada` (no crash).

- [ ] **Step 2 → 4:** FAIL → implement → PASS (`node --test tests/`)

- [ ] **Step 5: Commit**

```bash
git add server.mjs tests/server.test.mjs
git commit -m "feat: http api server"
```

---

### Task 7: Frontend — drill-down con μPlot

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`, `public/vendor/` (descargados)
- Test: verificación manual con Playwright (skill `superpowers:webapp-testing`)

**Interfaces:**
- Consumes: los 6 endpoints de Task 6.
- Produces: UI según spec §9. Estructura DOM estable (el implementador la crea así):
  - `#quota` (3 tarjetas con `%` o uso local + etiqueta fuente), `#range-select`, `#metric-select`, `#subagent-toggle`, `#refresh`
  - `#breadcrumb`, `#level-1`, `#level-2`, `#level-3`, `#drawer`, `#toast`
  - Estado JS: `{ range: '30d', metric: 'effective', projectId: null, sessionId: null, groupByParent: false }`
  - Funciones: `loadQuota()`, `loadProjects()`, `loadSessions(projectId)`, `loadMessages(sessionId)`, `openDrawer(messageId)`; en cada nivel se re-renderiza el gráfico μPlot (`bars` con valor + label) y se actualiza breadcrumb; `Esc` cierra drawer/nivel; click en barra navega; errores → toast.
  - Métricas del selector: `effective|cost|total|cacheRead`; orden descendente; color de barras por métrica; flags como íconos con `title` (tooltip nativo) y leyenda estática.
  - Estados vacío/cargando/error según spec §9-10. Subagentes: color secundario + toggle "agrupar por padre".

- [ ] **Step 1: Vendor μPlot**

```bash
mkdir -p public/vendor
curl -fsSL https://unpkg.com/uplot@1.6.32/dist/uPlot.iife.min.js -o public/vendor/uPlot.iife.min.js
curl -fsSL https://unpkg.com/uplot@1.6.32/dist/uPlot.min.css -o public/vendor/uPlot.min.css
```
Expected: ambos archivos existen y pesan > 20 KB. Commit del vendor (fijado a 1.6.32).

- [ ] **Step 2: Implementar `index.html` + `styles.css` + `app.js`**

- [ ] **Step 3: Verificación manual (Playwright, skill `webapp-testing`)**

`node server.mjs` y verificar: `/` carga; nivel 1 muestra barras ordenadas; click en la primera barra → nivel 2 visible con subagentes marcados; click en sesión → nivel 3; click en mensaje → drawer con tools; cambiar rango y métrica re-renderiza; `Esc` cierra; con `today` sin datos → estado vacío; consola del browser sin errores. Guardar captura de pantalla de los 3 niveles.

- [ ] **Step 4: Commit**

```bash
git add public/
git commit -m "feat: frontend drilldown with uplot"
```

---

### Task 8: Verificación cruzada, AGENTS.md y cierre

**Files:**
- Create: `scripts/verify.mjs`, `AGENTS.md`
- Test: `tests/verify.test.mjs` + corrida contra la BD real

**Interfaces:**
- Consumes: `openDb` y `listSessions`/`listMessages` (Tasks 2-3).
- Produces:
  - `scripts/verify.mjs`: para cada sesión compara `SUM(mensajes)` vs columnas de `session_v2` (input, output, reasoning, cache read/write, cost) e imprime `OK <n>/<n> sesiones` o las discrepancias con conteo; exit code ≠ 0 si hay discrepancias. Acepta path por argumento o default.
  - `AGENTS.md`: comandos (`npm start`, `npm test`, `node scripts/verify.mjs`), mapa de `lib/*` en 5 líneas, reglas: BD readonly, sin deps npm, UI en español, tokens nunca logueados.

- [ ] **Step 1: Test de `verify.mjs` contra fixture** (función exportada `verifyDb(db) -> { checked, mismatches: [] }`): con la fixture real da `0` mismatches; con una fixture donde un mensaje fue alterado a mano (input +1) da `1`.

- [ ] **Step 2:** FAIL → implement → PASS.

- [ ] **Step 3: Corrida contra la BD real**

Run: `node scripts/verify.mjs`
Expected: `OK n/n sesiones` (n ≈ 142, crece con el uso; 0 discrepancias). Si aparece alguna, reportarla y no seguir.

- [ ] **Step 4: E2E final**

`npm start` + Playwright: repetir flujo completo de Task 7 Step 3 contra datos reales; verificar panel de cuota con fuente `local` (API sigue en 401) y su causa visible. Revisar que la BD no fue modificada (abrir con `readOnly` sigue funcionando; `git status` limpio).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.mjs tests/verify.test.mjs AGENTS.md
git commit -m "chore: cross-check script and project agents guide"
```

---

## Self-Review Notes

- **Spec coverage:** §3-5 → Tasks 1-3; §6 → Task 4; §7 → Task 6; §8 → Task 5; §9-10 → Task 7 (+ estados en 6); §11 → tests por task + Task 8; §12-13 → decisiones reflejadas (sin deps, readonly, vendor). Cubierta completa.
- **Riesgo ⚠️:** el TUI de OpenCode escribe en la DB mientras corre; los tests leen datasets sintéticos (fixture) y `verify.mjs` corre contra la real en solo-lectura — sin carrera.
- La métrica `effective` se llama igual en JS y en las respuestas JSON para evitar renombres entre tasks.
