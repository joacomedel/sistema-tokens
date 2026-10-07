# Repo único sistemaTokens: app + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar `sistemaTokens` (app) y `sistemaTokens-mcp` (MCP) en un solo repo clonable basado en `sistemaTokens`, ejecutable como app (`npm start`) o como MCP (`npm run mcp`).

**Architecture:** El MCP se mueve a `mcp/` dentro de `sistemaTokens` con `git subtree`-style (preserva ambos historiales). La app no cambia ni sabe del MCP. El MCP queda en modo estricto: sin API de la app no funciona (`MCP_DB_FALLBACK=0` por default, `query_db` se elimina). Dos scripts simples, cero dependencias nuevas en la app.

**Tech Stack:** Node ≥ 24 ESM, `node:sqlite`, MCP SDK + zod solo bajo `mcp/` (instalación separada vía `mcp/package.json` propio o `npm --prefix mcp`).

**Spec:** Decisiones del usuario 2026-10-07: (1) base = `sistemaTokens`; (2) dos scripts simples; (3) estricto sin app no hay MCP; (4) preservar ambos historiales.

## Global Constraints

- La BD de OpenCode se abre siempre con `readOnly: true`; nunca escribir.
- `stdout` del MCP es canal JSON-RPC: logs solo por stderr.
- La app mantiene **cero dependencias npm**; el SDK MCP vive solo en `mcp/`.
- ESM, Node ≥ 24, sin build step.
- Tests primero (TDD) en cambios de comportamiento.
- Textos al usuario en español rioplatense; código y commits en inglés.

## Review Focus

- `npm run mcp` sin la app levantada debe fallar con mensaje accionable, no con stacktrace (ver Task 3).
- `npm start` / `npm test` de la app deben funcionar sin `mcp/node_modules` instalado (ver Task 2).
- Rutas portables al trabajo: nada hardcodeado a `/home/jm/` salvo defaults por env vars (ver Task 4).
- `store/` del MCP (contiene prompts) nunca se commitea (ver Task 2).
- El `opencode.jsonc` unificado no debe romper el registro actual por proyecto (ver Task 4).

---

### Task 1: Mover el MCP a `mcp/` preservando historiales

**Files:**
- Create: `mcp/` (todo el árbol de `sistemaTokens-mcp` menos `.git/`, `node_modules/`, `store/`)
- Modify: nada de la app en esta task
- Test: `git log --oneline -- mcp/index.mjs` muestra historial del MCP

**Interfaces:**
- Consumes: repos `/home/jm/opencode/sistemaTokens` (base) y `/home/jm/opencode/sistemaTokens-mcp` (donante)
- Produces: árbol `mcp/{index.mjs,src/,tests/,docs/,examples/}` con historial preservado

- [ ] **Step 1: Agregar el repo MCP como remote y fusionar con `--allow-unrelated-histories`**

```bash
cd /home/jm/opencode/sistemaTokens && git remote add mcp-donor /home/jm/opencode/sistemaTokens-mcp && git fetch mcp-donor && git checkout -b unificacion-mcp && git read-tree --prefix=mcp/ -u mcp-donor/main && git commit -m "feat: import sistemaTokens-mcp history under mcp/"
```

- [ ] **Step 2: Verificar que ambos historiales están presentes**

Run: `git log --oneline --graph -8 && echo --- && git log --oneline -- mcp/index.mjs | head -3 && echo --- && ls mcp/`
Expected: PASS si el log muestra commits de ambos repos y `mcp/index.mjs` existe con su historial.

- [ ] **Step 3: Commit** (incluido en el comando del Step 1; si hubo ajustes, commitearlos aparte)

```bash
git status --short && git add -A && git commit -m "feat: import sistemaTokens-mcp under mcp/"
```

### Task 2: Scripts duales sin contaminar la app

**Files:**
- Modify: `package.json` (agrega `mcp`, `install:mcp`, `test:mcp`)
- Modify: `mcp/package.json` (name `sistema-tokens-mcp`, paths relativos)
- Modify: `.gitignore` (agrega `mcp/node_modules/`, `mcp/store/`)
- Test: comandos de verificación abajo (no hay test de código nuevo, es wiring)

**Interfaces:**
- Consumes: árbol `mcp/` de Task 1
- Produces: `npm start` (app), `npm run mcp` (MCP stdio), `npm test` (solo app, sin MCP instalado)

- [ ] **Step 1: Editar `package.json` raíz**

```json
{ "scripts": {
  "start": "node --disable-warning=ExperimentalWarning server.mjs",
  "test": "node --disable-warning=ExperimentalWarning --test",
  "mcp": "node --disable-warning=ExperimentalWarning mcp/index.mjs",
  "install:mcp": "npm --prefix mcp install",
  "test:mcp": "npm --prefix mcp test",
  "verify": "node --disable-warning=ExperimentalWarning scripts/verify.mjs"
} }
```

- [ ] **Step 2: Verificar que la app funciona sin `mcp/node_modules`**

Run: `rm -rf mcp/node_modules && npm test 2>&1 | tail -3 && npm start & sleep 2 && curl -s http://127.0.0.1:4747/api/meta && kill %1`
Expected: tests en verde y `/api/meta` responde `200` sin el MCP instalado.

- [ ] **Step 3: Verificar que el MCP funciona con install separado**

Run: `npm run install:mcp && npm run test:mcp 2>&1 | tail -3`
Expected: PASS suite del MCP en verde.

- [ ] **Step 4: Commit**

```bash
git add package.json mcp/package.json .gitignore && git commit -m "feat: dual run modes app and mcp"
```

### Task 3: Modo estricto (sin app no hay MCP)

**Files:**
- Modify: `mcp/src/config.mjs` (`dbFallback` default `false`)
- Modify: `mcp/src/tools/query_db.mjs` (eliminar archivo) y `mcp/src/server.mjs` (desregistrar `query_db`)
- Modify: `mcp/src/client/db.mjs` (si queda sin uso, eliminar; si no, dejar solo como código muerto documentado — decidir en implementación y anotar)
- Test: `mcp/tests/strict-mode.test.mjs`

**Interfaces:**
- Consumes: `loadConfig(env)` de `mcp/src/config.mjs`, `loadApi` de `mcp/src/tools/common.mjs`
- Produces: MCP que falla con mensaje accionable cuando la API no responde

- [ ] **Step 1: Write the failing test `mcp/tests/strict-mode.test.mjs`**

```js
import { strictEqual } from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
test('dbFallback defaults to off', () => {
  strictEqual(loadConfig({}).dbFallback, false);
});
test('dbFallback opt-in via env', () => {
  strictEqual(loadConfig({ MCP_DB_FALLBACK: '1' }).dbFallback, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix mcp test 2>&1 | tail -5`
Expected: FAIL en `dbFallback defaults to off` (actual `true`).

- [ ] **Step 3: Implement strict default en `mcp/src/config.mjs`**

Cambiar `env.MCP_DB_FALLBACK !== '0'` por `env.MCP_DB_FALLBACK === '1'`. Eliminar `query_db.mjs` y su registro en `src/server.mjs`. Actualizar mensaje de `loadApi` si menciona `query_db` (nuevo texto: "Levantá la app con `npm start`...").

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix mcp test 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: ambas suites en verde.

- [ ] **Step 5: Verificación manual del mensaje sin app**

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spend_overview","arguments":{}}}\n' | npm run mcp 2>&1 | head -5` (con la app apagada)
Expected: error accionable que menciona `npm start`, no stacktrace.

- [ ] **Step 6: Commit**

```bash
git add mcp/ && git commit -m "feat(mcp): strict mode requires running app"
```

### Task 4: Portabilidad al trabajo (rutas y registro)

**Files:**
- Create/Modify: `opencode.jsonc` raíz (bloque MCP con `command: ["node", "./mcp/index.mjs"]` relativo o `$PWD`-free + `SISTEMA_TOKENS_URL`)
- Modify: `mcp/src/config.mjs` (`defaultStoreDir` relativo al archivo, no a `process.cwd()`)
- Modify: `README.md` (sección "Uso en otra máquina": clonar, `npm run install:mcp`, `npm start`, registrar MCP)
- Test: verificación manual abajo

**Interfaces:**
- Consumes: scripts de Task 2, strict mode de Task 3
- Produces: repo clonable que anda con `OPENCODE_DB` default por SO (`~/.local/share/opencode/opencode.db`)

- [ ] **Step 1: `opencode.jsonc` con path portable y `examples/` actualizado**

El `command` no debe contener `/home/jm/`. Usar ruta relativa al proyecto según soporte de OpenCode; si solo acepta absolutas, documentar `opencode mcp add sistemaTokens -- node "$PWD/mcp/index.mjs"` en el README.

- [ ] **Step 2: Verificación end-to-end desde un clon fresco**

Run: `rm -rf /tmp/opencode/e2e-clone && git clone . /tmp/opencode/e2e-clone && cd /tmp/opencode/e2e-clone && npm test 2>&1 | tail -2 && npm run install:mcp && (npm start & sleep 2 && curl -s http://127.0.0.1:4747/api/meta && kill %1)`
Expected: clon anda sin nada hardcodeado al home original.

- [ ] **Step 3: Commit**

```bash
git add opencode.jsonc mcp/src/config.mjs README.md && git commit -m "feat: portable single-repo setup for work machines"
```

### Task 5: Archivar repo viejo y cerrar

**Files:**
- Modify: `sistemaTokens-mcp` (solo README de archivo + archive en GitHub, fuera de este repo)
- Modify: `README.md` raíz (link al archivo viejo)

- [ ] **Step 1: Push de la rama y PR**

Run: `git push -u origin unificacion-mcp && gh pr create --title "Repo único: app + MCP" --body "Closes: unificación. Ver docs/superpowers/plans/2026-10-07-repo-unico-app-mcp.md"`
Expected: PR creado, CI/tests en verde.

- [ ] **Step 2: Tras el merge, archivar `sistemaTokens-mcp` en GitHub (README + Archive)**

Fuera del código: agregar aviso en su README y marcar como archived. Anotar en `~/.config/opencode/tasks/taskPendientes.md` si queda pendiente.
