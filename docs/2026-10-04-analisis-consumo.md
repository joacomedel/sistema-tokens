# Análisis de consumo de tokens — 2026-10-04

> Ignorando modelos gratis. Fuente: MCP sistemaTokens (range=all).

## Totales globales

| Métrica | Valor |
|---------|------:|
| Costo total | $8.25 |
| Tokens efectivos | 60.4M |
| Tokens totales | 707.5M |
| Cache read | 647.1M |
| Proyectos | 10 |
| Sesiones | 218 |

## Top proyectos por costo

| Proyecto | Costo | % del total | Sesiones |
|----------|------:|------------:|---------:|
| animaciones | $3.55 | 43% | 60 |
| sistemaTokens | $1.29 | 16% | 5 |
| optimizador | $0.93 | 11% | 16 |
| animacion-motor | $0.89 | 11% | 39 |
| consultas | $0.42 | 5% | 26 |
| sistemaTokens (worktree) | $0.40 | 5% | 4 |
| Global | $0.30 | 4% | 62 |
| intentoOrquestador | $0.16 | 2% | 6 |
| motor | $0.12 | 1% | 1 |
| sistemaTokens-mcp | $0.06 | 1% | 2 |

## Hallazgos accionables

### 1. Fan-out de subagentes — ~$1.20 evitable

- **animaciones**: 23 subagentes bajo un mismo padre (38.3% del costo del proyecto)
- **animacion-motor**: 19 subagentes bajo un mismo padre (48.7%)

Cada subagente repite el contexto completo. Si agrupás tareas relacionadas en una sola sesión en vez de lanzar 20+ subagentes, ahorrás la repetición de contexto.

### 2. Modelo caro para output corto — ~$0.65 evitable

- **sistemaTokens**: 78% del costo de la sesión más cara (`msg_0f9c3c524001V3Ef2ecEB9X1tp`) es `expensive_model_mismatch` — modelo caro con respuestas cortas
- **animaciones**: 21.2% del costo

Revisá si esas tareas pueden ir a un modelo más barato (deepseek-v4.1-flash en vez de pro).

### 3. Razonamiento excesivo — ~$0.46 evitable

- **animaciones**: 27.5% del costo (71 mensajes con high_reasoning_share)
- **sistemaTokens**: 29.8%

Prompts más claros y tareas más acotadas reducen el razonamiento. Si el prompt es ambiguo, el modelo "piensa" de más.

### 4. Cache sin usar — ~$0.34 evitable

- **animaciones**: `no_cache_input` (23.6%) + `low_cache_hit` (21%) = ~44% del costo

El contexto grande se está pagando completo en vez de reutilizar cache. Revisá por qué el prompt cambia de más o por qué el cache no aplica.

### 5. Output largo — ~$0.19 evitable

- **animaciones**: 25.2% del costo (38 mensajes con output ≥ 1000 tokens)

Pedir respuestas más concisas o acotar el alcance.

## Resumen de optimización

| Acción | Ahorro estimado |
|--------|----------------:|
| Agrupar subagentes (fan-out) | ~$1.20 |
| Modelo más barato para tareas simples | ~$0.65 |
| Prompts más claros (menos razonamiento) | ~$0.46 |
| Mejorar cache hit | ~$0.34 |
| Respuestas más concisas | ~$0.19 |
| **Total potencial** | **~$2.84** |

## Conclusión

El mayor impacto es el **fan-out de subagentes** — si lográs bajar de 23 a 5-6 subagentes por padre, ahorrás más de la mitad del gasto de animaciones. Segundo impacto: **modelo más barato** para tareas simples en sistemaTokens. Ambos juntos representan ~$1.85 de ahorro potencial (~22% del gasto total).
