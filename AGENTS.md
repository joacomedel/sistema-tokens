# sistemaTokens — guía para agentes

Visualizador local del consumo de tokens de OpenCode: drill-down **proyecto → sesión → mensaje**, con señales de causa y panel de cuota del plan.

## Comandos

- `npm start` — servidor en `http://127.0.0.1:4747` (puerto y límites en `config.json`).
- `npm test` — suite completa (`node:test`).
- `node scripts/verify.mjs [ruta]` — verificación cruzada contra la BD real; exit code ≠ 0 si hay discrepancias.

## Arquitectura

- `server.mjs` — HTTP + API JSON + estáticos; única superficie de entrada.
- `lib/db.mjs` — apertura readonly y queries de los 3 niveles (+ `childCounts`, `aggregatesFromSessions`).
- `lib/causes.mjs` — percentiles y señales de causa (`no_cache`, `long_output`, `expensive_model`, `high_reasoning`, `compacted`, `many_subagents`).
- `lib/quota.mjs` — API `/zen/go/v1/usage` con parseo tolerante y fallback local.
- `lib/ranges.mjs` — rangos temporales (`today|7d|30d|month|all`).
- `public/` — UI vanilla (barras CSS, sin dependencias). El render de barras vive en `renderBars()`.

## Reglas del proyecto

- La BD de OpenCode se abre **siempre** con `readOnly: true`; nunca ejecutar escrituras sobre ella.
- **Cero dependencias npm**: solo módulos nativos de Node ≥ 24 (`node:sqlite`, `node:http`, `fetch`).
- Scripts con `--disable-warning=ExperimentalWarning`.
- UI en español rioplatense; código, nombres y commits en inglés.
- Los tokens de cuota nunca se loguean ni se envían al frontend; el servidor escucha solo en `127.0.0.1`.
- Tests primero (TDD); cada cambio de comportamiento necesita un test que haya fallado antes.
