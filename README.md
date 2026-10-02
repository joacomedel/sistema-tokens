# sistemaTokens-mcp

MCP local para **analizar el gasto de tokens de OpenCode**, con foco en responder
*por qué* se gastó tanto y *si se podía optimizar*.

Reutiliza la API de [`sistemaTokens`](../sistemaTokens) (no recopia sus queries) y
usa como fallback la BD de OpenCode en **modo read-only**.

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
| `query_db` | SELECT ad-hoc contra la BD de OpenCode, read-only y con LIMIT forzado. |

Las salidas son texto resumido; con `raw: true` se agrega el JSON crudo. Cada run
queda guardado en `store/` (git-ignored) y es reconsultable con `recall`.

## Configuración (variables de entorno)

| Variable | Default | Uso |
|----------|---------|-----|
| `SISTEMA_TOKENS_URL` | `http://127.0.0.1:4747` | Base de la API de sistemaTokens |
| `OPENCODE_DB` | `$XDG_DATA_HOME/opencode/opencode.db` | BD de OpenCode |
| `MCP_DB_FALLBACK` | `1` | `0` desactiva el fallback a BD |
| `MCP_HTTP_TIMEOUT_MS` | `5000` | Timeout de la API |
| `MCP_STORE_DIR` | `<repo>/store` | Dónde se persisten los runs |
| `MCP_STORE` | `1` | `0` desactiva la persistencia |
| `MCP_CACHE_TTL_MS` | `600000` | Vigencia del raw para reutilizar |

## Uso

1. Levantá `sistemaTokens` (`npm start` en `../sistemaTokens`) para que la API
   responda en `127.0.0.1:4747`.
2. Este repo ya trae un `opencode.jsonc` **de proyecto**: el MCP queda registrado
   solo cuando abrís OpenCode en esta carpeta. Para usarlo en otro proyecto,
   copiá ese bloque (`examples/opencode.jsonc`) o corré
   `opencode mcp add sistemaTokens -- node /home/jm/opencode/sistemaTokens-mcp/index.mjs`.
3. El servidor habla por stdio; los logs van por stderr.

## Desarrollo

```bash
npm install
npm test        # node --test
npm start       # corre el server por stdio
```

Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
