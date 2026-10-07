# sistemaTokens-mcp

MCP local para **analizar el gasto de tokens de OpenCode**, con foco en responder
*por qué* se gastó tanto y *si se podía optimizar*.

Vive dentro del repo de [`sistemaTokens`](../README.md), en `mcp/`. En modo
estricto solo habla con la API de la app (no accede a la BD de OpenCode).

## Tools

| Tool | Qué hace |
|------|----------|
| `spend_overview` | Totales globales + top de proyectos. Punto de entrada barato. |
| `top_sessions` | Ranking de sesiones (subagentes incluidos). Sin `project`, recorre todos los proyectos. |
| `top_turns` | Turnos que concentran el gasto de una sesión. |
| `explain_message` | Detalle de un mensaje: tokens, tools y disparador (prompt o task del subagente padre). |
| `diagnose` | Diagnóstico causal por nivel (`global/project/session/turn/message`) con evidencia y el próximo nivel a bajar. |
| `quota_status` | Ventanas de cuota del plan. |
| `recall` | Reconsulta runs guardados (raw) sin reanalizar. |

Cada salida trae el resumen en texto y los datos principales en `structuredContent`
(proyectos en `spend_overview`, ranking en `top_sessions`, etc.). Con `raw: true`
se agrega el JSON crudo completo. Cada run queda guardado en `store/` (git-ignored)
y es reconsultable con `recall`.

## Modo estricto (solo API)

El MCP no accede a la BD de OpenCode: todo pasa por la API de `sistemaTokens`.
Sin la app levantada no hay datos: cada tool responde `isError` con el mensaje
`Levantá la app con 'npm start' ...`. La BD la lee la app (en modo read-only); el
MCP nunca la toca.

## Base de datos (V1/V2)

La app sirve los datos desde la BD de OpenCode, que tiene dos modelos y **la fuente canónica para el gasto es la V2**:

| Tabla | Rol |
|-------|-----|
| `session_message` + `session_v2` | V2, superset: incluye las sesiones V1 migradas y las nuevas. |
| `message` | Formato V1 (histórico). Analizar solo esto subestima el gasto (~57 %). |

Regla práctica: los agregados de costo salen de `session_message`/`session_v2`; `message` no se usa para totales.

## Configuración (variables de entorno)

| Variable | Default | Uso |
|----------|---------|-----|
| `SISTEMA_TOKENS_URL` | `http://127.0.0.1:4747` | Base de la API de sistemaTokens |
| `MCP_HTTP_TIMEOUT_MS` | `5000` | Timeout de la API |
| `MCP_STORE_DIR` | `<repo>/store` | Dónde se persisten los runs |
| `MCP_STORE` | `1` | `0` desactiva la persistencia |
| `MCP_CACHE_TTL_MS` | `600000` | Vigencia del raw para reutilizar |

## Uso

1. Levantá la app (`npm start` en la raíz del repo) para que la API
   responda en `127.0.0.1:4747`.
2. El MCP corre por stdio: `npm run mcp`. Los logs van por stderr.
3. Para registrarlo en otro proyecto, copiá el bloque de `examples/opencode.jsonc`
   o corré `opencode mcp add sistemaTokens -- node "$PWD/mcp/index.mjs"`.

## Desarrollo

```bash
npm install
npm test        # node --test
npm start       # corre el server por stdio
```

Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
