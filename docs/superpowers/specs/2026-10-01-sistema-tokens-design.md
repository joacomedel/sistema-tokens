# Sistema de visualización de consumo de tokens de OpenCode

**Fecha:** 2026-10-01
**Estado:** Diseño aprobado en conversación — pendiente de revisión del usuario sobre este documento
**Proyecto:** `sistemaTokens` (app web local, un solo usuario)

---

## 1. Objetivo

App web local y liviana que lee la base de datos de OpenCode (SQLite) y visualiza el consumo de tokens con drill-down de tres niveles —**proyecto → sesión → mensaje**— mostrando tokens, costo en USD y cuota del plan, con señales visuales que permitan encontrar **cuellos de botella de consumo** en segundos.

**Éxito se ve así:** abro la app, veo qué proyecto concentra el gasto, hago click y encuentro la sesión y hasta el mensaje que lo explica (p. ej. "contexto sin cache" u "output largo"), sin tocar jamás la base de OpenCode.

## 2. Alcance

**Incluye:**
- Lectura **solo-lectura** de `opencode.db` (jamás escribe).
- Drill-down de 3 niveles con gráficos de barras: proyectos → sesiones → mensajes.
- Panel de cuotas del plan (API oficial con fallback local).
- Señales de causa automáticas y detección de outliers.
- Filtros por rango temporal y por métrica.
- Detalle de mensaje con resumen de tool calls.

**No incluye (YAGNI):**
- Multi-usuario, autenticación, deploy remoto.
- Escritura o modificación de datos de OpenCode.
- Exportación de reportes, alertas, notificaciones.
- Snapshots históricos propios (la BD de OpenCode ya es el histórico).
- Facturación real de otros proveedores (se usa el `cost` que OpenCode registra).

## 3. Fuente de datos (verificado contra la BD real el 2026-10-01)

- **OpenCode v2.0.21.** Base SQLite: `$XDG_DATA_HOME/opencode/opencode.db`, con fallback `~/.local/share/opencode/opencode.db` (~84 MB, modo WAL activo).
- **Node 24.12** lee la BD con `node:sqlite` en modo `readOnly: true` sin problemas (verificado con WAL activo). Aviso "ExperimentalWarning" esperado: se silencia con `--disable-warning=ExperimentalWarning`.

### Tablas y campos usados

| Tabla | Campos relevantes |
|---|---|
| `project` | `id`, `worktree` (carpeta raíz), `name` (habitualmente `null`) |
| `session_v2` | `id`, `project_id`, `parent_id` (subagentes), `title`, `directory`, `model` (JSON string: `{"id","providerID","variant"}`), `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `time_created`, `time_updated`, `time_compacting`, `time_archived` |
| `message` | `id`, `session_id`, `time_created`, `data` (JSON) |
| `part` | `id`, `message_id`, `session_id`, `data` (JSON) |
| `account` | `access_token`, `token_expiry` (fallback de cuota) |
| `credential` | `value` (API key del provider, `integration_id = 'opencode'`) |

### JSON internos (verificados)

- `message.data` (assistant): `role`, `cost`, `tokens {input, output, reasoning, cache {read, write}, total}`, `modelID`, `providerID`, `variant`, `agent`, `time {created, completed}` (epoch ms).
- `part.data`: `type` ∈ {`text`, `reasoning`, `tool`, `step-start`, `step-finish`}. Un `tool` trae `callID`, `tool` (nombre), `state`.
- **Consistencia verificada:** la suma de tokens/costo de los mensajes de una sesión coincide **exactamente** con los agregados de `session_v2` (comprobado en las sesiones más grandes).
- Subagentes: 50 de 142 sesiones tienen `parent_id`.
- Un proyecto con worktree `/` (sesiones globales) se muestra como **"Global"**.

## 4. Arquitectura

**Stack:** Node 24 puro — `node:sqlite`, `node:http` y `fetch` nativos. Frontend HTML/CSS/JS vanilla con **μPlot** (gráficos, ~45 KB) servido local. **Cero dependencias npm, cero build step, cero CDN.**

```
sistemaTokens/
├── package.json           # solo metadata + scripts (start/dev/test); sin dependencies
├── server.mjs             # servidor HTTP + ruteo /api/* + estáticos
├── lib/
│   ├── db.mjs             # apertura readonly + queries de los 3 niveles + detalle
│   ├── causes.mjs         # percentiles, outliers y señales de causa
│   ├── quota.mjs          # API de cuotas + parseo tolerante + caché + fallback local
│   └── ranges.mjs         # resolución de rangos temporales (today/7d/30d/month/all)
├── public/
│   ├── index.html
│   ├── app.js             # estado, fetch, render de barras, drill-down, drawer
│   ├── styles.css
│   └── vendor/            # uPlot.iife.min.js + uPlot.min.css (descargados una vez)
├── config.json            # puerto, dbPath, límites manuales de cuota, TTL de caché
├── tests/                 # tests con node:test + BD fixture
├── scripts/verify.mjs     # verificación cruzada contra la BD real (readonly)
├── AGENTS.md              # guía para agentes del repo (se crea en implementación)
└── docs/superpowers/specs/2026-10-01-sistema-tokens-design.md
```

- **Un solo proceso** escuchando en `127.0.0.1:4747` (configurable). Nunca `0.0.0.0`.
- **`db.mjs` es la única puerta a SQLite** (si `node:sqlite` cambia, se reemplaza internamente sin tocar el resto).
- Flujo: navegador → `/api/*` → `db.mjs`/`quota.mjs` → JSON. El frontend solo pinta; todos los cálculos (agregados, percentiles, señales) viven en backend.
- Reintento simple (3×100 ms) si la BD está momentáneamente bloqueada por un checkpoint de WAL.

## 5. Queries y modelo de cálculo

- **Filtro de rango:** por `message.time_created` (epoch ms). Rangos: `today`, `7d`, `30d`, `month` (mes calendario, desde el día 1) y `all`. **Default: `30d`.** Timezone local del sistema.
- **Niveles 1 y 2** se calculan sumando los mensajes assistant del rango (precisión temporal real, verificada idéntica a los agregados de sesión). Con estos volúmenes (2.2k mensajes) el costo es imperceptible.
- **Nivel 1 — Proyectos:** `GROUP BY project_id`; label = `name ?? basename(worktree)`; worktree `/` → "Global".
- **Nivel 2 — Sesiones:** `GROUP BY session_id` dentro del proyecto; incluye subagentes con su `parent_id`, `title`, `model`, `time_compacting`.
- **Nivel 3 — Mensajes:** mensajes assistant de la sesión, con `modelID/providerID/variant`, duración (`completed - created`) y conteo de tools por nombre.
- **Detalle:** desglose completo del mensaje + tools agrupadas por nombre con conteo (sin contenido de los textos).
- **Tokens efectivos = `input + output + reasoning`** (≈ `total − cache_read − cache_write`). Métrica de orden/color por defecto. El cache-read/write se muestra aparte para no distorsionar.
- **USD:** el `cost` que OpenCode ya registró (modelos gratuitos = USD 0 legítimo; no se inventan precios).

## 6. Señales de causa

| Señal | Condición | Nivel | Nota |
|---|---|---|---|
| `contexto sin cache` | `cache_read = 0` y `input ≥ p75` del set visible | 2, 3 | El caso más caro típico |
| `output largo` | `output ≥ p90` del set | 2, 3 | |
| `modelo caro` | `cost / tokens efectivos ≥ 2× mediana` (n ≥ 5) | 2, 3 | |
| `razonamiento alto` | `reasoning ≥ p90` del set | 2, 3 | |
| `se compactó` | `time_compacting` no nulo | 2 | |
| `muchos subagentes` | sesión padre con ≥ 5 hijas | 2 | |

- Umbrales por **percentiles dinámicos del set visible** (no números mágicos), calculados en `causes.mjs`.
- Máximo 2 señales visibles por barra (ordenadas por severidad); tooltip las explica. Nivel 1 muestra un resumen ("3 sesiones con señales").

## 7. API interna (JSON, solo localhost)

| Endpoint | Params | Devuelve |
|---|---|---|
| `GET /api/meta` | — | Rango default, salud de BD, estado de cuota (`api`/`local`/`unavailable`), última sincronización |
| `GET /api/projects` | `range` | Nivel 1: proyectos con tokens, costo, sesiones, resumen de señales |
| `GET /api/projects/:id/sessions` | `range` | Nivel 2: sesiones con métricas, `parent_id`, señales |
| `GET /api/sessions/:id/messages` | `range` | Nivel 3: mensajes con métricas, duración, señales |
| `GET /api/messages/:id` | — | Detalle + tools agrupadas |
| `GET /api/quota` | `refresh=1` | Ventanas `rolling`/`weekly`/`monthly` |

- Cada ítem incluye `{ metrics: {...}, flags: [...] }`.
- Errores: `{ "error": { "code", "message" } }` con status HTTP correcto.
- Sin caché de datos locales (instantáneos); caché solo para cuota.

## 8. Cuotas del plan

**Resultado del spike (2026-10-01):** el endpoint `GET https://opencode.ai/zen/go/v1/usage` existe (401 JSON estructurado) y es el correcto según implementaciones comunitarias (pi-usage, opencode-usage): `Authorization: Bearer <API key de Go>` + `Accept: application/json`. La key local **sí es válida** ( `/zen/go/v1/models` → 200), pero `/usage` respondió **401** tanto con la key del provider como con el token OAuth. Es un endpoint indocumentado; probablemente exige suscripción Go activa con el scope correspondiente. El diseño no depende de esto.

**Estrategia en capas (`quota.mjs`):**
1. Intento API con credenciales locales en orden: `credential` (provider) → `account` (OAuth).
2. Parseo **tolerante** del shape conocido: `usage.{rolling, weekly, monthly}` → `{ percent | percentage, resetsAt | resetAt | reset_at (ISO o epoch-ms) }`. Sin datos → no se inventa nada.
3. Caché de 60 s (configurable) + reintento periódico + botón "reintentar" en la UI.
4. **Fallback local:** si la API falla, el panel muestra el uso local por ventana (5 h móviles; semana calendario ISO; mes calendario) en USD y tokens, calculado de la BD. Si `config.json` define `quota.manualLimits` (USD), muestra además el % consumido. La UI distingue siempre **"oficial (API)"** de **"calculado local"** con la causa del fallback (`401`, red, etc.).

**Seguridad:** los tokens nunca se loguean, nunca viajan al frontend y nunca se persisten fuera de la BD. Toda comparación es server-side.

## 9. UI/UX

```
┌──────────────────────────────────────────────────────────┐
│  CUOTAS   [5h ▓▓░░ 18%]  [Semanal ▓░░ 6%]  [Mes ▓ 2%]    │ ← API o local
├──────────────────────────────────────────────────────────┤
│  Rango [30d ▾]   Métrica [USD ▾]   ☑ Subagentes   ⟳     │
├──────────────────────────────────────────────────────────┤
│  PROYECTOS  (barras)                                     │
│   ████████ animaciones            $2.15   ⚠ output largo │
│   ██████   agentes/optimizador    $0.69   ⚠ sin cache    │
└──────────────────────────────────────────────────────────┘
   click ▸ nivel 2 (sesiones)  ▸ click ▸ nivel 3 (mensajes)
   click en mensaje ▸ drawer lateral: desglose + tool calls
```

- **Navegación:** breadcrumb (`Proyectos / animaciones / …`); `Esc` cierra drawer o nivel; sin rutas complejas ni recarga de página.
- **Métricas seleccionables:** tokens efectivos (default) / USD / tokens totales / cache-read. Cambian orden y color.
- **Subagentes:** borde punteado + color secundario + toggle "agrupar por padre".
- **Señales:** ícono + color por barra, tooltip explicativo, leyenda fija.
- **Estados:** cargando (skeleton), vacío ("sin datos en este rango") y error, cada uno con mensaje claro.
- **Drawer de mensaje:** timestamp, modelo/variante, agente, desglose de tokens, costo, duración, resumen de tools.

## 10. Errores y degradación

| Falla | Comportamiento |
|---|---|
| BD ausente/bloqueada | Pantalla explicativa con el path esperado y cómo verificar; la app no crashea |
| JSON corrupto en un mensaje/part | Se saltea el ítem y se muestra contador "N ilegibles"; el resto funciona |
| API de cuota caída / 401 | Fallback local + indicador de causa y botón reintentar |
| Endpoint API interna con error | JSON `{error:{code,message}}` + toast en el frontend sin perder el estado |

## 11. Testing y validación

- **Unit tests** (`node:test`, sin dependencias): `db.mjs` (agregaciones de los 3 niveles, filtros, nombres), `causes.mjs` (percentiles, cada señal), `quota.mjs` (parseo tolerante con respuestas mockeadas, fallback), `ranges.mjs`. Fixture: BD SQLite temporal con esquema mínimo y datos sintéticos.
- **`scripts/verify.mjs`:** contra la BD real (readonly) comprueba que suma de mensajes = agregados de `session_v2` para todas las sesiones e imprime discrepancias.
- **Verificación cruzada en runtime:** nivel 1 = Σ nivel 2 = Σ nivel 3 para el mismo rango.
- **UI:** prueba manual con Playwright (click → nivel 2 → nivel 3 → drawer; probar rangos y métricas; estados de error).
- **Rendimiento esperado:** respuestas < 100 ms con los datos actuales; si creciera mucho, top-N barras + "otros".

**Criterios de aceptación:**
1. Drill-down completo en 3 niveles por click, con breadcrumb y `Esc`.
2. Señales y outliers visibles y correctos según los umbrales definidos.
3. Panel de cuota mostrando datos oficiales o fallback local claramente etiquetado.
4. Los tres niveles cuadran entre sí para cualquier rango.
5. La BD de OpenCode no se modifica: la app la abre en modo readonly y no ejecuta ninguna sentencia de escritura (verificable por diseño y en revisión de código).
6. Ninguna dependencia npm; arranca con `npm start` (o `node server.mjs`) y abre en `http://localhost:4747`.

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `node:sqlite` es experimental | Aislado en `db.mjs`; si cambia, se cambia solo esa capa (plan B: `better-sqlite3`) |
| `/usage` indocumentado y hoy responde 401 | Capas + parseo tolerante + fallback local; reintentos |
| Formato JSON interno de OpenCode v2 puede cambiar | Lectura defensiva por `json_extract` con defaults; `verify.mjs` lo detecta temprano |
| WAL bloqueado momentáneamente | Reintentos cortos; nunca se abre en escritura |
| Volumen futuro de datos | Top-N + "otros"; queries con índice implícito por PK |

## 13. Decisiones de diseño (y alternativas descartadas)

- **Node 24 puro (elegida)** vs. Vite+React (peso y build step innecesarios) vs. Python (dos lenguajes sin ganancia). Sin dependencias = no se rompe por versiones.
- **μPlot** (45 KB, sin dependencias, muy rápido) vs. Chart.js/ECharts (más peso).
- **Sin `ccusage`:** sus adaptadores leen los JSON legacy; la v2 es SQLite y además necesitamos drill-down por mensaje con señales, que ninguna herramienta da.
- **USD real de OpenCode**, sin tabla de precios propia (YAGNI hoy).
- **Cuota por API con fallback manual**, porque el endpoint rechazó las credenciales locales en el spike pero puede habilitarse solo (reintentos automáticos ya previstos).
