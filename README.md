# sistemaTokens

Visualizador local del consumo de tokens de **[OpenCode](https://opencode.ai) v2** — _local token-usage visualizer for OpenCode v2_.

Navegá **proyecto → sesión → mensaje** con barras clickeables, señales de causa automáticas y panel de cuota del plan. Pensado para encontrar a ojo los cuellos de botella de consumo: qué carpeta gasta, qué sesión (o subagente) lo explica, y qué mensaje puntual lo causó.

## Requisitos

- **OpenCode v2** (probado con v2.0.21), con su base SQLite en `~/.local/share/opencode/opencode.db` (o `$XDG_DATA_HOME/opencode/opencode.db`).
- **Node.js ≥ 24** (usa `node:sqlite` nativo).
- **Cero dependencias npm, cero build step, cero CDN.**

## Uso

```bash
npm start                 # http://127.0.0.1:4747
npm test                  # suite completa (node:test)
node scripts/verify.mjs   # verificación cruzada contra tu BD real
```

El puerto y los límites manuales de cuota se configuran en `config.json`.

## Qué muestra

- **Nivel 1 — Proyectos:** qué carpeta de trabajo concentra tokens, costo y sesiones.
- **Nivel 2 — Sesiones:** una barra por sesión, con los subagentes marcados y agrupables por su padre.
- **Nivel 3 — Mensajes:** cada respuesta del modelo con tokens (input/output/reasoning/cache), costo, duración y resumen de tool calls.
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
