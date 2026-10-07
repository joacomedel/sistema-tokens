# Evaluación del MCP `sistemaTokens` desde el uso real de un agente

- **Fecha:** 1/10/2026
- **Evaluador:** agente de OpenCode, durante el análisis de gasto de tokens del usuario (postmortem completo, ver `~/opencode/analisis-gasto-tokens/por-que-gasto-tokens.md`)
- **Objeto:** las 8 tools del MCP `sistemaTokens-mcp` contra el server de `sistemaTokens`
- **Entorno:** OpenCode v2, server `http://127.0.0.1:4747` corriendo (HTTP 200), BD real del usuario

---

## Resumen ejecutivo

El MCP **se pudo usar**, pero no alcanzó para hacer el análisis: **todo el trabajo numérico terminó saliendo de `query_db`**, que fue la única tool que funcionó siempre y sin sorpresas.

El problema de fondo es un **bug de render**: 4 de las 8 tools (`top_sessions`, `top_turns`, `explain_message`, `quota_status`) **devuelven vacío en su modo por defecto** y solo entregan datos con `raw: true`. Como `raw` a su vez entrega payloads muy verbosos (102 KB una lista de sesiones, ~3 KB por turno), el agente termina eligiendo SQL directo.

Un segundo problema, más sutil: **los errores se diagnostican mal**. Un 404 por "mensaje de usuario sin tokens" se reporta como *"no se pudo consultar la API, levantá el server"*, cuando el server está perfectamente levantado. Eso manda al agente a debuggear el problema equivocado.

Y un tercer problema silencioso: **`query_db` corta en 20 filas sin avisar**. En un análisis agregado por directorio eso trunca el ranking sin ningún síntoma visible.

Veredicto: **la base está buena** (caché, store, errores accionables, señales de `diagnose` útiles), pero el MCP no está listo para ser la fuente primaria de un agente. Hoy, para análisis serio, el agente prefiere `query_db` y el MCP queda como fachada de conveniencia.

---

## 1. Qué tenía que resolver el agente

1. Ranking de proyectos por costo.
2. Ranking de modelos/agentes por costo.
3. Identificar los **turnos** (prompt → respuestas) más caros.
4. Entender la **composición** del gasto (input vs output vs reasoning vs cache).
5. Detectar **desperdicio**: subagentes, duplicados, contexto inflado.

---

## 2. Uso real: qué pasó con cada tool

| Tool | ¿Sirvió? | Observación |
|---|---|---|
| `spend_overview` | ✅ Sí | Totales correctos. Único caso donde el modo por defecto **sí** renderiza. |
| `top_sessions` | ⚠️ Solo con `raw` | Sin `raw` devuelve `{runId, cached, metric}`. Con `raw`, 102 KB. |
| `top_turns` | ⚠️ Solo con `raw` | Sin `raw`, `{runId, cached}`. Con `raw`, ~3 KB por turno (texto + flags de cada mensaje). |
| `explain_message` | ❌ Con reservas | Sin `raw`, vacío. Con `raw`, **buenísimo**… pero 404 si el id es de un mensaje de usuario. |
| `diagnose` | ✅ Sí, el mejor | Findings útiles en global/project/session/turn/message(assistant). |
| `query_db` | ✅ Sí, pero con trampa | Funciona siempre; trunca en 20 filas sin avisar; no acepta `PRAGMA`. |
| `quota_status` | ⚠️ Parcial | Sin `raw`, vacío. Con `raw`, `source: local` por 401; `percent` y `resetsAt` en `null`. |
| `recall` | ❌ Roto | Lista OK; `recall(runId)` devuelve solo el id; `recall(runId, path)` rompe el schema del SDK. |

Resumen: **2 tools buenas, 3 a medias, 2 rotas, 1 con trampa.**

---

## 3. Bugs encontrados (con repro)

### P0 — 4 tools devuelven vacío sin `raw: true`

Es el bug de mayor impacto: en el primer contacto el agente cree que la tool no tiene datos.

```js
top_sessions({ range: "7d", limit: 5 })
// → {"runId":"7e131b10d920","cached":false,"metric":"effective"}   ← nada

top_turns({ sessionId: "ses_...", range: "all", limit: 3 })
// → {"runId":"c6f5a79ae213","cached":true}                        ← nada

explain_message({ messageId: "msg_0f0425..." })
// → {"runId":"fc7ae4b1c906","cached":false}                       ← nada

quota_status({})
// → {"runId":"05bc369f34de","cached":false}                       ← nada
```

Pero el dato **existe y está bien calculado**: `recall` muestra que el run de `top_sessions` guardó **102.652 bytes**. Se calcula todo y se descarta al formatear.

**Contraste:** `spend_overview({range:"7d"})` **sin** `raw` devuelve `totals` completo. La inconsistencia hace pensar que el problema es de datos y no de formato.

- **Esperado:** el modo por defecto debería renderizar un resumen en texto/tabla legible (es lo que un LLM necesita).
- **Actual:** el agente tiene que adivinar `raw: true` y comerse payloads de 100 KB.
- **Impacto medido:** los 3 primeros intentos de uso del MCP rindieron 0 información útil.

### P0 — `query_db` trunca en 20 filas sin avisar

```js
query_db({ sql: "SELECT id FROM session_v2 ORDER BY id LIMIT 100", raw: true })
// → { rows: [ …20 filas… ], raw: [ …20 filas… ] }
// claves del resultado: ["rows","raw"]  ← sin flag de truncado
```

- **Esperado:** respetar el `LIMIT` del usuario, o devolver un tope configurable, o al menos `{ truncated: true, total }`.
- **Actual:** tope silencioso de 20 filas.
- **Impacto real:** el ranking por proyecto salió truncado y tuve que repetir el análisis ordenando al revés (`ORDER BY cost ASC`) para recuperar la cola. Un análisis agregado normal queda incompleto sin que el agente lo sepa.
- **Extra:** `PRAGMA table_info(...)` se rechaza (solo `SELECT`/`WITH`). Para descubrir el esquema hubo que usar `sqlite_master`. Razonable por seguridad, pero obliga a un workaround que quizás convendría documentar o permitir en modo lectura.

### P1 — `explain_message` y `diagnose(scope=message)` fallan con mensajes de usuario

```js
explain_message({ messageId: "msg_0efc35e7d001d9mDoB2JgRum7Z" })  // "Si segui "
// → Error: "No se pudo consultar la API de sistemaTokens (HTTP 404) en
//    /api/messages/msg_0efc35e7... Levantá el server de sistemaTokens (npm start)
//    o usá query_db contra la BD."

// La misma id vía diagnose(turn) → OK
diagnose({ scope: "turn", sessionId: "ses_...", id: "msg_0efc35e7..." })  // ✅
```

El server **sí tiene** la ruta `/api/messages/:id` (responde bien para mensajes de assistant). El 404 viene de adentro: `getMessageDetail()` en `lib/db.mjs` devuelve `null` si el mensaje no es `assistant` con `tokens`. Un mensaje de usuario nunca califica.

**Dos problemas en uno:**

1. **Funcional:** la pregunta más natural —*"¿qué prompt disparó este gasto?"*— no se puede responder con `explain_message(prompt_id)`; solo yendo desde un mensaje de assistant que ya se conoce (`trigger.user.text`).
2. **Diagnóstico:** el MCP convierte un "mensaje no encontrado" en "la API no responde / levantá el server". Con el server arriba, eso es un falso positivo que desorienta al agente.

- **Esperado:** aceptar mensajes de usuario (devolviendo trigger/prompt y, si aplica, la sesión), y distinguir `404 not_found` de `ECONNREFUSED` en el mensaje de error.

### P1 — `recall` roto en los dos modos útiles

```js
recall({ limit: 8 })                                  // ✅ lista runs (útil)
recall({ runId: "37e9e34a59a5" })                     // → {"runId":"37e9e34a59a5"}   ← vacío
recall({ runId: "37e9e34a59a5", path: "raw.items.0" }) // → MCP error -32602: Invalid tools/call result:
        // invalid_union … path ["text"] expected string, received undefined
```

- El run existe (119.793 bytes en el índice).
- **Esperado:** `recall(runId)` devuelve el raw del run; `recall(runId, path)` devuelve el valor de la ruta.
- **Actual:** el primero devuelve solo el id; el segundo genera un resultado MCP inválido (`text: undefined`) que **rompe el SDK**, no un error de la tool.
- **Nota:** el índice mostró **entradas duplicadas** para el mismo `runId` (dos registros con 1 ms de diferencia). Convendría deduplicar.

### P2 — `diagnose(scope=project|session)` devuelve labels con IDs crudos

```
diagnose({scope:"project", id:"b845f209..."} )
 → subject.label: "b845f209fb36f50ad45586bc365e25e1235c6d9d"   ← esperaba "animaciones"

diagnose({scope:"session", id:"ses_f106a4cd1ffe..."} )
 → subject.label: "ses_f106a4cd1ffeE345b4KI3x1Afj"             ← esperaba el título de la sesión
```

`scope=global` sí resuelve el nombre (`label: "animaciones"`). Inconsistente. Además, las referencias de las "next actions" arrastran IDs crudos en vez de slug amigable. Para un humano es ruido; para un agente, un id más para correlacionar a mano.

### P2 — `quota_status` no distingue "sin plan" de "no autenticado"

```json
{ "source": "local", "error": "401 Unauthorized",
  "windows": [ { "id": "rolling", "percent": null, "resetsAt": null, "usedUsd": 2.188758 }, … ] }
```

El fallback local es correcto y valioso (siempre devuelve algo), pero `percent` y `resetsAt` quedan en `null` sin explicar si es porque no hay plan Go, porque la credencial no sirve o porque la API cambió. El README ya advierte que el endpoint es indocumentado; estaría bueno que el output diga cuál de las tres es.

### P2 — Dependencia del server HTTP sin red de contención

**6 de las 8 tools** (`diagnose`, `spend_overview`, `top_sessions`, `top_turns`, `explain_message`, `quota_status`, todas vía `loadApi`) requieren el server de `sistemaTokens` corriendo en el puerto configurado. Si no está, fallan. Solo `query_db` y `recall` (store local) funcionan sin server. El mensaje de error es **bueno** (dice qué hacer y la URL), pero:

- no hay auto-start ni fallback a la BD (aunque `query_db` demuestra que la BD está accesible);
- no hay una tool de estado tipo `healthcheck` que diga "server OK / BD OK / quota OK".

---

## 4. Lo que sí funcionó bien

- **`query_db`** es la joya: read-only, guardas de `SELECT`/`WITH`, JSON1 disponible (`json_extract`), y suficiente para todo. El análisis del postmortem salió de acá.
- **`diagnose`** da hallazgos concretos y accionables con severidad e `hypothesis` en lenguaje natural. Ejemplos reales que usé:
  - `cost_concentration` 76,8 % (global) → apuntaba al proyecto correcto antes de que yo lo supiera;
  - `subagent_fanout` 69,7 % (proyecto `animaciones`) → detectó los 23 subagentes;
  - `high_reasoning_share` 31,1 % (turno "Si segui ") → confirmó la causa del turno más caro.
- **Caché + store de runs** (`cached: true` en llamadas repetidas) funcionan.
- **Mensajes de error accionables**, en español, con URL y próximos pasos. Es un estándar que el resto del MCP cumple bien.
- **`spend_overview`** es el único caso de "modo por defecto listo para usar". Es el modelo que deberían seguir las demás.

---

## 5. Impacto en el análisis real

| Momento | Qué pasó | Costo para el agente |
|---|---|---|
| Primer contacto | `top_sessions` devolvió vacío | 1 llamada perdida, tuve que ir a SQL |
| Descubrimiento del esquema | `PRAGMA` rechazado | Tuve que usar `sqlite_master` |
| Ranking por proyecto | `query_db` truncó en 20 filas | Ranking incompleto; tuve que repetir con orden inverso |
| Pregunta "¿qué prompt lo disparó?" | `explain_message` 404 + mensaje que culpaba al server | Fui a SQL a reconstruir turnos |
| Análisis V1 vs V2 | El MCP no lo advierte en sus salidas | Interpreté mal los datos en la primera pasada (dije "animaciones = 81 %" cuando era el 39 %) |

Sobre el último punto, para ser justo: **la API del MCP devolvía el número correcto**. El error fue mío al caer a `query_db` sobre la tabla equivocada. Pero es exactamente el tipo de trampa que el MCP debería señalar: si `query_db` es el fallback recomendado, una línea en su descripción u output del estilo *"la fuente autoritativa de totales es `session_v2`; `message` es histórico y está podado"* habría evitado el error.

---

## 6. Recomendaciones priorizadas

### P0 (rompen la experiencia del agente)

1. **Renderizar por defecto** en `top_sessions`, `top_turns`, `explain_message` y `quota_status`. Reusar el formato de `spend_overview`. `raw: true` debe ser una opción de escape, no el único camino a los datos.
2. **`query_db`: dejar de truncar en silencio.** O respetar el `LIMIT` del usuario, o devolver `{ truncated: true, shown: 20 }`. Un tope silencioso en una tool de análisis produce conclusiones erróneas sin error.
3. **Arreglar `recall`.** `recall(runId)` debe devolver el run; `recall(runId, path)` debe devolver un string válido (hoy rompe el schema del SDK). Deduplicar el índice.

### P1 (funcionalidad y diagnóstico)

4. **Soportar mensajes de usuario en `explain_message` / `diagnose(scope=message)`**: que devuelvan el prompt y qué respondió, en vez de 404.
5. **Distinguir causas de error en `loadApi`:** `not_found` (404 del recurso) vs `server_offline` (conexión rechazada) vs `api_error`. Hoy los tres culpan al server. Dato: `ApiError` ya trae `status` — la información existe, solo falta usarla al armar el mensaje.

### P2 (pulido)

6. Resolver labels humanos en `diagnose(project|session)`: nombre del proyecto y título de sesión, no IDs.
7. `quota_status`: explicar por qué `percent`/`resetsAt` vienen `null` (sin plan / sin credencial / API caída).
8. `top_turns`: un modo compacto (sin el detalle de cada mensaje) para cuando el agente solo quiere el ranking; hoy son ~3 KB por turno.
9. Nota sobre V1/V2 en la descripción de `query_db` (o en su output).
10. Healthcheck: `sistemaTokens_status` que reporte server, BD y cuota de una sola vez.

---

## Anexo: repro mínimo

```bash
# Server arriba (HTTP 200) y aun así...
curl -s "http://127.0.0.1:4747/api/messages/<ID_DE_USUARIO>"
# → {"error":{"code":"not_found","message":"mensaje no encontrado"}}

# ...mientras que un mensaje de assistant responde bien:
curl -s "http://127.0.0.1:4747/api/messages/<ID_DE_ASSISTANT>"
# → {"id":"…","tokens":{…},"cost":…}
```

```js
// 1) Vacío por defecto
top_sessions({ range: "7d", limit: 5 })        // → solo runId/cached/metric

// 2) Truncado silencioso
query_db({ sql: "SELECT id FROM session_v2 LIMIT 100" })  // → 20 filas, sin flag

// 3) recall roto
recall({ runId: "<id existente>" })            // → { runId }
recall({ runId: "<id existente>", path: "raw.items.0" })  // → MCP -32602 invalid_union
```

---

*Informe generado desde el uso real del MCP durante un análisis de gasto de tokens. Todas las observaciones tienen repro ejecutado contra el server y la BD del usuario.*
