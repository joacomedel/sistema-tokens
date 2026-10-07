# sistemaTokens

Visualizador local del consumo de tokens de **[OpenCode](https://opencode.ai) v2** — _local token-usage visualizer for OpenCode v2_.

Navegá **proyecto → sesión → turno → mensaje** con barras clickeables, señales de causa automáticas y panel de cuota del plan. Pensado para encontrar a ojo los cuellos de botella de consumo: qué carpeta gasta, qué sesión (o subagente) lo explica, qué turno concentró el gasto y qué mensaje puntual lo causó.

## Requisitos

- **OpenCode v2** (probado con v2.0.21), con su base SQLite en `~/.local/share/opencode/opencode.db` (o `$XDG_DATA_HOME/opencode/opencode.db`).
- **Node.js ≥ 24** (usa `node:sqlite` nativo).
- **Cero dependencias npm, cero build step, cero CDN.**

## Uso

```bash
npm start                 # http://127.0.0.1:4747
npm test                  # suite completa (node:test)
node scripts/verify.mjs   # verificación cruzada contra tu BD real

# MCP (opcional): consultas por lenguaje natural desde OpenCode
npm run install:mcp       # instala las deps del MCP (una vez)
npm run mcp               # corre el MCP por stdio (requiere la app levantada)
npm run test:mcp          # suite del MCP
```

El puerto y los límites manuales de cuota se configuran en `config.json`.

## App y MCP en el mismo repo

Este repo tiene dos formas de usarse y comparten los mismos datos (la BD de OpenCode, leída por la app):

- **App** (`npm start`): visual en `http://127.0.0.1:4747`. Es la superficie principal.
- **MCP** (`mcp/`, `npm run mcp`): tools de consulta para OpenCode (`spend_overview`, `top_sessions`, `diagnose`, `quota_status`, `recall`, …). Habla con la app por HTTP; **en modo estricto no accede a la BD**, así que necesita la app levantada.

### Clonar en otra máquina (p. ej. el trabajo)

```bash
git clone <url-del-repo> && cd sistemaTokens
npm start            # solo la app: cero dependencias, anda directo
```

Para el MCP, una vez clonado:

```bash
npm run install:mcp
opencode mcp add sistemaTokens -- node "$PWD/mcp/index.mjs"   # global, disponible en todo proyecto
```

El repo ya trae un `opencode.jsonc` de proyecto con la ruta **relativa** (`command: ["node","mcp/index.mjs"]`, `cwd: "."`), así que si abrís OpenCode dentro del repo el MCP queda registrado sin editar nada. La BD y el puerto se toman de los defaults del SO (`$XDG_DATA_HOME/opencode/opencode.db`); nada está hardcodeado a una máquina.

## Qué muestra

- **Nivel 1 — Proyectos:** qué carpeta de trabajo concentra tokens, costo y sesiones.
- **Nivel 2 — Sesiones:** una barra por sesión, con los subagentes marcados y agrupables por su padre.
- **Nivel 3 — Turnos:** una barra por cada prompt que enviás, con tokens/costo sumados de sus respuestas, cantidad de mensajes y cuántos traen señales.
- **Nivel 4 — Mensajes:** las llamadas específicas del turno, con tokens (input/output/reasoning/cache), costo, duración y resumen de tool calls.
- **Disparador:** en el detalle de un mensaje se ve qué lo originó: el prompt del usuario que abrió el turno, qué venía diciendo el modelo justo antes (para entender respuestas cortas como "sí"), y si la sesión es un subagente, la sesión padre y el tool `task` que lo lanzó. Se navega con **◀ anterior / siguiente ▶** dentro del turno (o las flechas ←/→).
- **Señales automáticas** (percentiles del set visible): contexto sin cache · output largo · modelo caro · razonamiento alto · sesión compactada · exceso de subagentes.
- **Panel de cuota:** ventanas de 5 h / semanal / mensual del plan Go vía API, con fallback de cálculo local si la API no responde.
- Filtros de rango (hoy / 7 días / 30 días / mes / todo) y de métrica (tokens efectivos / USD / tokens totales / cache-read).

## Privacidad y seguridad

- La base de OpenCode se abre **siempre en modo solo-lectura**: la app nunca escribe en ella.
- Todo corre en tu máquina (`127.0.0.1`); el contenido de tus mensajes no sale de ahí.
- La única conexión externa es la consulta de cuota a `opencode.ai` (best-effort; si falla, se calcula local). Las credenciales nunca se registran en logs ni se envían al navegador.

## Notas sobre los datos (OpenCode v2)

- Los totales por proyecto y sesión salen de `session_v2`, la fuente autoritativa.
- Los mensajes viven en `message` (histórico v1) y `session_message` (v2). **OpenCode poda** los mensajes más viejos de esta última: por eso el nivel 3 puede mostrar menos tokens que el total de la sesión. La app te lo avisa en pantalla en vez de mostrar números incompletos.
- El endpoint de cuota (`/zen/go/v1/usage`) es indocumentado y puede requerir un plan Go activo con la credencial correcta; si no responde, la app lo dice y calcula local.

## Estado

Proyecto personal, pensado para uso local. Forks y PRs bienvenidos. No está afiliado a OpenCode ni a SST.

## Licencia

MIT — ver [LICENSE](LICENSE).
