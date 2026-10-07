# sistemaTokens-mcp — guía para agentes

MCP local (stdio) que **analiza el gasto de tokens de OpenCode**. Reutiliza por
HTTP la API de `sistemaTokens` (fuente primaria) y usa la BD de OpenCode en modo
**read-only** como fallback y para consultas ad-hoc.

## Comandos

- `npm install` — instala dependencias.
- `npm test` — suite completa (`node --test`).
- `npm start` — corre el server MCP por stdio (no imprime a stdout).
- `opencode mcp list` — verifica el registro de proyecto; debe decir `connected`.

## Arquitectura

- `index.mjs` — entry: arma `deps` y conecta `StdioServerTransport`.
- `src/config.mjs` — entorno → config (URL de la API, BD, store, TTL).
- `src/server.mjs` — `buildServer(deps)`; `DEFAULT_TOOLS` registra las 8 tools.
- `src/client/api.mjs` — cliente HTTP (`get`), lanza `ApiError`.
- `src/client/db.mjs` — SQLite read-only + `guardSelect`.
- `src/analyze/thresholds.mjs` — umbrales calibrados contra la BD real.
- `src/analyze/aggregate.mjs` — `sumMetrics`, `percentile`, `topShare`.
- `src/analyze/heuristics.mjs` — `analyzeMessages`, `analyzeConcentration`, `analyzeFanout`.
- `src/analyze/format.mjs` — formato de texto de las salidas.
- `src/store/runs.mjs` — store de runs (raw + índice, TTL, `recall`).
- `src/tools/*.mjs` — una tool por archivo; `common.mjs` expone `resolveRaw`,
  `toolResult` y `loadApi`.

## Reglas del proyecto

- La BD de OpenCode se abre **siempre** con `readOnly: true`; nunca escribir.
- **stdout es el canal JSON-RPC**: logs solo por `console.error`/stderr.
- Reutilizar la API de `sistemaTokens`; no recopiar sus queries.
- Tools read-only; `query_db` acepta solo `SELECT`/`WITH` y fuerza `LIMIT`.
- Las tools exponen el resumen principal en `structuredContent` siempre; `raw` es opcional y queda en el store para `recall`.
- Umbrales únicos y versionados en `src/analyze/thresholds.mjs`.
- `store/` va en `.gitignore` (contiene prompts y mensajes).
- ESM, Node ≥ 24, sin build step.
- Tests primero (TDD): cada cambio de comportamiento necesita un test que haya
  fallado antes.
- Textos al usuario en español rioplatense; código, identificadores y commits en
  inglés.
- Config de proyecto en `opencode.jsonc` (aplica solo en esta carpeta).

## Gotchas

- El SDK MCP registra `tools/list` recién en el primer `registerTool`; un server
  sin tools responde `-32601`.
- `resolveRaw` cachea por `(tool, params)` dentro del TTL; con `MCP_STORE=0` no
  persiste.
- `loadApi` convierte fallas de red en un error accionable (no un stacktrace).
- `diagnose(scope=turn)` requiere `sessionId` + `id`; para `project`/`session` sin
  `id`, arranca desde el hijo más caro.
- Gasto: la fuente canónica es V2 (`session_message`/`session_v2`); `message` es V1
  y subestima (~57 %). No mezclar tablas en agregados.
