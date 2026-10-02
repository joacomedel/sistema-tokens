# sistemaTokens-mcp — diseño

MCP local para **analizar el gasto de tokens de OpenCode** reutilizando la API de
`sistemaTokens`, con foco en responder *por qué* se gastó tanto y *si se podía
optimizar*.

Fecha: 2026-10-01
Estado: revisada — pendiente calibrar umbrales contra la BD real

## Problema

`sistemaTokens` permite navegar a mano `proyecto → sesión → turno → mensaje` y
ver señales de causa, pero:

- El recorrido es manual: hay que cliquear nivel por nivel para llegar al
  mensaje caro.
- No hay una vista que **agregue** las causas ("el 62% del costo vino de 3
  turnos sin cache") ni que **sugiera** optimizaciones.
- Un agente (OpenCode, Claude, etc.) no puede consultar esa información como
  herramienta.
- Reanalizar lo mismo cuesta (contexto y tiempo): no hay memoria de los análisis
  hechos.

## Objetivo

Un servidor **MCP** que exponga, como tools, el drill-down que ya existe en la
API y una capa de **diagnóstico causal** sobre el gasto, para que un agente
pueda responder preguntas como:

- ¿Qué proyecto/sesión/turno/mensaje concentra el gasto?
- ¿Por qué: sin cache, modelo caro, output largo, razonamiento alto,
  compactaciones, fan-out de subagentes, re-lecturas?
- ¿Se podía optimizar? ¿Qué cambiaría?

Además, cada análisis debe quedar **guardado en crudo** para poder reconsultarlo
después sin volver a analizar todo.

## No-objetivos

- No escribe nunca en la BD de OpenCode ni en `sistemaTokens`.
- No reimplementa las queries de `sistemaTokens` (las reutiliza por HTTP).
- No tiene UI ni hosting remoto; es local (stdio).
- No reemplaza a `sistemaTokens`; lo complementa.
- No arranca el server de `sistemaTokens` solo (queda a cargo del usuario).

## Decisiones tomadas

| Tema | Decisión |
|------|----------|
| Reutilización | HTTP API de `sistemaTokens` + fallback read-only a la BD de OpenCode |
| SDK | `@modelcontextprotocol/sdk` oficial |
| Análisis | Evidencia + heurísticas; el agente que llama cierra la recomendación |
| Repo | `/home/jm/opencode/sistemaTokens-mcp`, independiente |
| Lenguaje | JavaScript ESM (Node ≥ 24, sin build step) |
| Transporte | stdio (MCP local) |
| Alcance de `top_sessions` | Sin `project`, recorre **todos** los proyectos |
| Profundidad de `diagnose` | **Un nivel por llamada** + `next` para bajar |
| Salidas | **Resumen** por defecto + **raw** a pedido |
| Raw | Se **persiste** en el repo para reconsultar sin reanalizar |
| Umbrales | **Calibrados contra la BD real** (read-only), versionados en el código |

## Arquitectura

```
agente (OpenCode/cliente MCP)
        │  stdio (JSON-RPC)
        ▼
sistemaTokens-mcp
  ├── tools/            → definición y handlers de cada tool
  ├── client/api.mjs    → fetch a SISTEMA_TOKENS_URL
  ├── client/db.mjs     → SQLite read-only (fallback + query_db)
  ├── analyze/          → heurísticas de diagnose y agregación de causas
  ├── store/            → persistencia de runs (raw crudo + índice)
  └── index.mjs         → arranque del server MCP
        │
        ├── HTTP ──► sistemaTokens (127.0.0.1:4747)  ← fuente primaria
        └── SQLite ─► ~/.local/share/opencode/opencode.db  ← fallback/ad-hoc
```

### Fuente primaria vs fallback

- **API (`sistemaTokens`)**: proyectos, sesiones, turnos, mensajes, cuota,
  rangos, poda. Es la fuente autoritativa de la estructura.
- **BD directa**: se usa cuando (a) la API no está disponible, o (b) el tool
  `query_db` necesita algo que la API no expone. La conexión es `readOnly`.

### Store de runs (raw persistido)

Cada ejecución de un tool que trae/analiza datos genera un **run**:

- `store/runs/<runId>.json`: el **raw completo** de la respuesta (API + findings).
- `store/index.jsonl`: una línea por run con `runId`, `tool`, `params`, `range`,
  `createdAt`, `source` (`api|db|cache`) y tamaño.

Reglas:

- `runId` = hash determinístico de `(tool, params normalizados)`; la misma
  consulta reusa el mismo id y actualiza el raw (se conserva el último).
- `MCP_CACHE_TTL_MS`: si existe un run para la misma consulta y no venció, los
  tools **reutilizan** el raw en vez de pegarle a la API o recalcular.
- El raw se retiene igual aunque venza el TTL: sirve para `recall`.
- `store/` va en `.gitignore`; contiene prompts/mensajes, es local y sensible.
- `MCP_STORE=0` desactiva la persistencia por completo.

## Configuración

Variables de entorno (declaradas al registrar el MCP en `opencode.json`):

| Variable | Default | Uso |
|----------|---------|-----|
| `SISTEMA_TOKENS_URL` | `http://127.0.0.1:4747` | Base de la API |
| `OPENCODE_DB` | `$XDG_DATA_HOME/opencode/opencode.db` (o `~/.local/share/...`) | BD para fallback/ad-hoc |
| `MCP_DB_FALLBACK` | `1` | `0` desactiva el fallback a BD |
| `MCP_HTTP_TIMEOUT_MS` | `5000` | Timeout de requests a la API |
| `MCP_STORE_DIR` | `<repo>/store` | Dónde se persisten los runs |
| `MCP_STORE` | `1` | `0` desactiva la persistencia |
| `MCP_CACHE_TTL_MS` | `600000` (10 min) | Vigencia del raw para reutilizar |

Ejemplo de registro en `opencode.jsonc` (schema V2: los servers van bajo
`mcp.servers`, y se usa `disabled` para dejarlo configurado sin conectar):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "sistemaTokens": {
        "type": "local",
        "command": ["node", "/home/jm/opencode/sistemaTokens-mcp/index.mjs"],
        "environment": {
          "SISTEMA_TOKENS_URL": "http://127.0.0.1:4747"
        }
      }
    }
  }
}
```

Alternativa por CLI: `opencode mcp add sistemaTokens -- node /home/jm/opencode/sistemaTokens-mcp/index.mjs`.

## Tools

Todas read-only. Por defecto devuelven **texto resumido** (para cuidar el
contexto del agente); con `raw: true` devuelven además el **JSON crudo**. Todo
run queda registrado en el store y es reconsultable con `recall`.

`range` ∈ `today | 7d | 30d | month | all` (default `30d`).
`metric` ∈ `effective | cost | total | cacheRead` (default `effective`).

### `spend_overview(range, raw?)`
Totales globales + top N proyectos. Punto de entrada barato.
Fuente: `GET /api/projects?range=`.

### `top_sessions(range, project?, metric?, limit=10, raw?)`
Ranking de sesiones (incluye subagentes marcados y agrupables). **Sin `project`,
recorre todos los proyectos** y devuelve el ranking global.
Fuente: `GET /api/projects/:id/sessions` por cada proyecto.

### `top_turns(sessionId, limit=10, raw?)`
Turnos que concentran el gasto de una sesión, con prompt y señales.
Fuente: `GET /api/sessions/:id/turns?range=`.

### `explain_message(messageId, raw?)`
Detalle del mensaje + desglose de tokens + tools + "¿por qué?" + disparador
(prompt del usuario, o task del subagente padre).
Fuente: `GET /api/messages/:id`.

### `diagnose(scope, id?, range?, raw?)`
**El core.** Diagnostica **un nivel** del árbol y devuelve hallazgos con
evidencia más las posibilidades de bajar el nivel siguiente.

- `scope`: `global | project | session | turn | message`.
- Sin `id`, arranca en el nivel más caro del scope (`global` → proyecto top).

Devuelve:

```json
{
  "runId": "a1b2c3d4",
  "scope": "project",
  "subject": { "id": "...", "label": "..." },
  "range": "30d",
  "totals": { "effective": 0, "cost": 0, "messages": 0, "turns": 0 },
  "findings": [
    {
      "code": "no_cache_input",
      "severity": "high",
      "share_pct": 62,
      "subject": { "type": "turn", "id": "...", "label": "Turno 7" },
      "evidence": { "input": 120000, "cache_read": 0, "cost": 1.23 },
      "hypothesis": "Contexto grande re-pagado completo por turno; habilitar cache o recortar contexto."
    }
  ],
  "next": ["diagnose scope=session id=<la sesión que concentra el gasto>"]
}
```

El `runId` queda en el store: se puede pedir el crudo completo con
`recall(runId)` sin reanalizar.

Reglas heurísticas (umbrales provisorios, a calibrar contra la BD real):

| Code | Disparador |
|------|-----------|
| `cost_concentration` | top 3 turnos/mensajes ≥ 50% del costo del scope |
| `no_cache_input` | input alto sin `cacheRead` (≥ p75 del set) |
| `low_cache_hit` | `cacheRead / (cacheRead+input)` bajo con contexto grande |
| `expensive_model_mismatch` | flag `expensive_model` en turnos con pocas tool calls / output corto |
| `high_reasoning_share` | reasoning ≥ 25% de los tokens efectivos |
| `long_output` | flag `long_output` (output ≥ p90) |
| `subagent_fanout` | muchos subagentes con contexto repetido |
| `repeated_tool_calls` | mismos tool calls repetidos dentro de una sesión |
| `compaction_overhead` | sesiones con `compacted` y costo alto post-compactación |

Cada finding incluye **evidencia numérica**; la recomendación final la redacta
el agente que llamó al tool.

### `quota_status(raw?)`
Ventanas de cuota del plan. Fuente: `GET /api/quota`.

### `recall(runId?, path?, limit=20, raw?)`
Re-consulta análisis previos desde el store, **sin** volver a pegarle a la API ni
recalcular.

- Sin `runId`: lista los últimos runs (id, tool, params, fecha, tamaño).
- Con `runId`: devuelve el raw guardado; si se pasa `path` (dotted, ej.
  `findings.0.evidence`), devuelve solo esa parte.

### `query_db(sql, raw?)`
Consulta ad-hoc read-only para profundizar (ej. partes/raw que la API no da).

Guardrails:
- Conexión `readOnly`.
- Solo **una** sentencia, y debe empezar con `SELECT` o `WITH`.
- Rechaza `INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|PRAGMA|VACUUM`.
- Agrega `LIMIT 500` si no hay `LIMIT`.
- Timeout de ejecución.

## Calibración de umbrales

Los umbrales de las heurísticas se calibran contra la BD real de OpenCode
(lectura `readOnly`), no a ojo. Método:

- Para cada métrica relevante (input, `cacheRead`, output, reasoning, costo por
  millón, tool calls por turno, subagentes por sesión, hit ratio de cache) se
  calculan percentiles sobre las sesiones y mensajes del periodo.
- Cada umbral de la tabla se fija en p75/p90 (o mediana, según la métrica).
- Los valores resultantes se documentan y quedan como constantes versionadas en
  `analyze/thresholds.mjs`, con un test que las valide.

No requiere que `sistemaTokens` esté corriendo: se lee la BD directo.

## Testing (repo del MCP)

- `client/api.mjs`: server HTTP falso (`node:http`) con fixtures de respuestas.
- `analyze/*`: tablas de casos → findings esperados (sin red, sin BD).
- `client/db.mjs`: sqlite temporal `readOnly`; casos de `query_db` permitido y
  bloqueado.
- `store/*`: escritura/lectura de runs, reutilización por TTL, `recall` por id y
  por path; store desactivado.
- Smoke de integración opcional contra `sistemaTokens` real (marcado, no en CI).

## Privacidad y seguridad

- Todo local (`stdio`, `127.0.0.1`).
- Nunca escribe: API es de solo lectura y la BD se abre `readOnly`.
- El `store/` contiene prompts y mensajes: queda en `.gitignore`, es local y se
  puede desactivar con `MCP_STORE=0`.
- No loguea credenciales ni tokens de cuota.
- `query_db` restringido como se describe arriba.

## Próximo paso

Con la spec revisada: **calibrar umbrales** contra la BD real (read-only) y
luego escribir el **plan de implementación** (writing-plans). Recién después se
codea con TDD.
