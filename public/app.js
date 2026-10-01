'use strict';

const state = {
  range: '30d',
  metric: 'effective',
  projectId: null,
  sessionId: null,
  groupByParent: false,
  data: { projects: null, sessions: null, messages: null },
};

const METRIC_COLORS = {
  effective: '#60a5fa',
  cost: '#fbbf24',
  total: '#a78bfa',
  cacheRead: '#94a3b8',
};

const FLAG_ICONS = {
  no_cache: '🚫',
  long_output: '📤',
  expensive_model: '💸',
  high_reasoning: '🧠',
  compacted: '🗜️',
  many_subagents: '👥',
  summary: '⚠️',
};

const $ = (id) => document.getElementById(id);

/* ---------- formato ---------- */
const compactFmt = new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('es-AR');

function fmtTokens(n) {
  return compactFmt.format(n ?? 0);
}
function fmtUsd(n) {
  const v = n ?? 0;
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}
function fmtValue(value, metric) {
  return metric === 'cost' ? fmtUsd(value) : fmtTokens(value);
}
function fmtDate(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- api / feedback ---------- */
async function api(path) {
  const res = await fetch(path);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // respuesta sin JSON
  }
  if (!res.ok) throw new Error(body?.error?.message ?? `Error ${res.status}`);
  return body;
}

let toastTimer = null;
function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

function errorContent(container, message) {
  container.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'state error';
  p.textContent = `Error: ${message}`;
  container.appendChild(p);
}

function emptyContent(container) {
  container.innerHTML = '<p class="state">Sin datos en este rango.</p>';
}

/* ---------- render de barras ---------- */
function flagsHtml(flags = []) {
  return flags.map((f) => `<span class="flag" title="${escapeHtml(f.label)}">${FLAG_ICONS[f.code] ?? '⚠️'}</span>`).join('');
}

function renderBars(container, items, { onSelect } = {}) {
  container.innerHTML = '';
  if (!items.length) return emptyContent(container);

  const max = Math.max(...items.map((i) => i.value ?? 0), 1);
  const color = METRIC_COLORS[state.metric];

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bar-row';
    if (item.parentId) row.classList.add('subagent');
    if (item.indented) row.classList.add('indented');
    if (item.title) row.title = item.title;

    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(1.5, ((item.value ?? 0) / max) * 100)}%`;
    fill.style.background = color;
    row.appendChild(fill);

    const content = document.createElement('span');
    content.className = 'bar-content';
    content.innerHTML = `<span class="bar-name">${escapeHtml(item.name)}</span><span class="bar-notes">${escapeHtml(item.notes ?? '')}</span>`;
    row.appendChild(content);

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = fmtValue(item.value, state.metric);
    row.appendChild(value);

    const flags = document.createElement('span');
    flags.className = 'bar-flags';
    flags.innerHTML = flagsHtml(item.flags);
    row.appendChild(flags);

    if (onSelect) row.addEventListener('click', () => onSelect(item));
    container.appendChild(row);
  }
}

/* ---------- cuota ---------- */
async function loadQuota() {
  const el = $('quota');
  try {
    const q = await api('/api/quota');
    const source = q.source === 'api' ? 'oficial (API)' : 'calculado local';
    el.innerHTML = q.windows.length
      ? q.windows
          .map((w) => {
            const value = w.percent != null ? `${w.percent}%` : w.usedUsd != null ? fmtUsd(w.usedUsd) : '—';
            const extra = w.resetsAt ? `reinicia ${fmtDate(Date.parse(w.resetsAt))}` : '';
            return `<div class="quota-card"><span class="quota-label">${escapeHtml(w.label)}</span><span class="quota-value">${value}</span><span class="quota-extra">${escapeHtml(extra)}</span></div>`;
          })
          .join('')
      : '<div class="quota-card"><span class="quota-label">Cuota</span><span class="quota-value">—</span></div>';
    el.insertAdjacentHTML(
      'beforeend',
      `<span class="quota-source">${escapeHtml(source)}${q.error ? ` · ${escapeHtml(q.error)}` : ''}</span>`,
    );
  } catch (err) {
    errorContent(el, err.message);
  }
}

/* ---------- nivel 1: proyectos ---------- */
async function loadProjects() {
  const el = $('level-1');
  el.classList.remove('hidden');
  el.classList.add('loading');
  try {
    const body = await api(`/api/projects?range=${state.range}`);
    state.data.projects = body;
    renderProjects();
  } catch (err) {
    errorContent(el, err.message);
  } finally {
    el.classList.remove('loading');
  }
  renderBreadcrumb();
}

function renderProjects() {
  const body = state.data.projects;
  if (!body) return;
  const items = body.items.map((p) => ({
    id: p.id,
    kind: 'project',
    name: p.label,
    notes: `${p.worktree} · ${p.sessions} sesiones · ${fmtUsd(p.metrics.cost)}`,
    value: p.metrics[state.metric],
    flags: p.flagsSummary?.sessionsWithSignals
      ? [{ code: 'summary', label: `${p.flagsSummary.sessionsWithSignals} sesiones con señales` }]
      : [],
  }));
  items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  renderBars($('level-1'), items, { onSelect: (item) => openProject(item.id) });
}

/* ---------- nivel 2: sesiones ---------- */
async function loadSessions(projectId) {
  const el = $('level-2');
  el.classList.remove('hidden');
  el.classList.add('loading');
  try {
    const body = await api(`/api/projects/${projectId}/sessions?range=${state.range}`);
    state.data.sessions = body;
    renderSessions();
  } catch (err) {
    errorContent(el, err.message);
  } finally {
    el.classList.remove('loading');
  }
  renderBreadcrumb();
}

function sessionItems() {
  const body = state.data.sessions;
  if (!body) return [];
  const mapped = body.items.map((s) => ({
    id: s.id,
    kind: 'session',
    parentId: s.parentId,
    name: s.title || '(sin título)',
    notes: `${s.modelId ?? 'modelo desconocido'} · ${fmtDate(s.timeCreated)}${s.parentId ? ' · subagente' : ''}`,
    value: s.tokens[state.metric],
    flags: s.flags,
  }));
  mapped.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (!state.groupByParent) return mapped;

  const roots = mapped.filter((m) => !m.parentId);
  const byParent = new Map();
  for (const child of mapped.filter((m) => m.parentId)) {
    if (!byParent.has(child.parentId)) byParent.set(child.parentId, []);
    byParent.get(child.parentId).push(child);
  }
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    out.push(root);
    seen.add(root.id);
    for (const child of byParent.get(root.id) ?? []) {
      out.push({ ...child, indented: true });
      seen.add(child.id);
    }
  }
  for (const m of mapped) if (!seen.has(m.id)) out.push(m);
  return out;
}

function renderSessions() {
  renderBars($('level-2'), sessionItems(), { onSelect: (item) => openSession(item.id) });
}

/* ---------- nivel 3: mensajes ---------- */
async function loadMessages(sessionId) {
  const el = $('level-3');
  el.classList.remove('hidden');
  el.classList.add('loading');
  try {
    const body = await api(`/api/sessions/${sessionId}/messages?range=${state.range}`);
    state.data.messages = body;
    renderMessages();
  } catch (err) {
    errorContent(el, err.message);
  } finally {
    el.classList.remove('loading');
  }
  renderBreadcrumb();
}

function messageNotes(m) {
  const t = m.tokens;
  const parts = [m.modelId ?? '—'];
  parts.push(`in ${fmtTokens(t.input)}`);
  parts.push(`out ${fmtTokens(t.output)}`);
  if (t.reasoning > 0) parts.push(`🧠 ${fmtTokens(t.reasoning)}`);
  if (t.cacheRead > 0 || t.cacheWrite > 0) parts.push(`cache ${fmtTokens(t.cacheRead + t.cacheWrite)}`);
  parts.push(fmtDuration(m.durationMs));
  if (m.agent) parts.push(m.agent);
  return parts.join(' · ');
}

function messageTooltip(m) {
  const t = m.tokens;
  const lines = [
    `input: ${intFmt.format(t.input)}`,
    `output: ${intFmt.format(t.output)}`,
    `reasoning: ${intFmt.format(t.reasoning)}`,
    `cache read: ${intFmt.format(t.cacheRead)}`,
    `cache write: ${intFmt.format(t.cacheWrite)}`,
    `tokens efectivos: ${intFmt.format(t.effective)}`,
    `costo: ${fmtUsd(t.cost)}`,
  ];
  if (m.flags.length) lines.push(`señales: ${m.flags.map((f) => f.label).join(', ')}`);
  return lines.join('\n');
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Explica el consumo de un mensaje en relación al resto de la sesión. */
function whyLines(m, setItems) {
  const t = m.tokens;
  const lines = [];

  const med = median(setItems.map((x) => x.tokens.effective));
  if (med != null && med > 0) {
    const ratio = t.effective / med;
    lines.push(
      ratio >= 1.5
        ? `Gastó ${intFmt.format(t.effective)} tokens efectivos: ${ratio.toFixed(1)}× la mediana de la sesión (${intFmt.format(Math.round(med))}).`
        : `Gastó ${intFmt.format(t.effective)} tokens efectivos, en línea con la mediana de la sesión.`,
    );
  }

  const comp = [`input ${intFmt.format(t.input)}`, `output ${intFmt.format(t.output)}`];
  if (t.reasoning > 0) comp.push(`razonamiento ${intFmt.format(t.reasoning)}`);
  if (t.cacheRead > 0) comp.push(`cache read ${intFmt.format(t.cacheRead)} (barato)`);
  lines.push(`Composición: ${comp.join(' · ')}.`);

  if (t.cacheRead === 0 && t.input > 0) {
    lines.push(`Sin cache: el contexto de entrada se pagó completo (${intFmt.format(t.input)} tokens).`);
  } else if (t.cacheRead > 0) {
    const share = Math.round((t.cacheRead / (t.cacheRead + t.input)) * 100);
    lines.push(`Cache: ~${share}% del contexto entró por cache; el input nuevo fue ${intFmt.format(t.input)} tokens.`);
  }

  for (const f of m.flags) {
    if (f.code === 'long_output') lines.push(`Output largo: la respuesta generó ${intFmt.format(t.output)} tokens.`);
    if (f.code === 'high_reasoning') lines.push(`Razonamiento alto: ${intFmt.format(t.reasoning)} tokens pensando.`);
    if (f.code === 'expensive_model' && t.effective > 0) {
      lines.push(`Modelo caro: ${fmtUsd((t.cost / t.effective) * 1e6)} por millón de tokens efectivos.`);
    }
  }

  if (m.durationMs != null) lines.push(`Tardó ${fmtDuration(m.durationMs)}.`);
  return lines;
}

function renderMessages() {
  const body = state.data.messages;
  if (!body) return;
  const el = $('level-3');
  const items = body.items.map((m, i) => ({
    id: m.id,
    kind: 'message',
    name: `#${i + 1} · ${fmtTime(m.timeCreated)}`,
    notes: messageNotes(m),
    value: m.tokens[state.metric],
    flags: m.flags,
    title: messageTooltip(m),
  }));
  items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  renderBars(el, items, { onSelect: (item) => openDrawer(item.id) });
  const notes = [];
  if (body.partial && body.sessionTotals) {
    notes.push(
      `Mostrando ${fmtTokens(body.totals.effective)} de ${fmtTokens(body.sessionTotals.effective)} tokens efectivos de la sesión: OpenCode poda los mensajes más viejos, y esos no se pueden desglosar.`,
    );
  }
  if (body.skipped > 0) {
    notes.push(`${body.skipped} mensajes salteados (datos ilegibles o sin tokens)`);
  }
  for (const note of notes.reverse()) {
    const p = document.createElement('p');
    p.className = 'state';
    p.textContent = note;
    el.prepend(p);
  }
}

/* ---------- drawer ---------- */
async function openDrawer(messageId) {
  const el = $('drawer');
  el.classList.remove('hidden');
  el.innerHTML = '<p class="state">Cargando…</p>';
  try {
    const d = await api(`/api/messages/${messageId}`);
    const setItem = state.data.messages?.items.find((x) => x.id === messageId) ?? null;
    const why = setItem ? whyLines(setItem, state.data.messages.items) : [];
    el.innerHTML = `
      <button id="drawer-close" type="button" aria-label="Cerrar">✕</button>
      <h3>Mensaje</h3>
      <dl class="detail">
        <dt>Fecha</dt><dd>${fmtDate(d.timeCreated)}</dd>
        <dt>Modelo</dt><dd>${escapeHtml(d.modelId ?? '—')}${d.variant ? ` (${escapeHtml(d.variant)})` : ''}</dd>
        <dt>Proveedor</dt><dd>${escapeHtml(d.providerId ?? '—')}</dd>
        <dt>Agente</dt><dd>${escapeHtml(d.agent ?? '—')}</dd>
        <dt>Duración</dt><dd>${fmtDuration(d.durationMs)}</dd>
        <dt>Costo</dt><dd>${fmtUsd(d.tokens.cost)}</dd>
      </dl>
      <h4>Tokens</h4>
      <dl class="detail">
        <dt>Efectivos</dt><dd>${intFmt.format(d.tokens.effective)}</dd>
        <dt>Input</dt><dd>${intFmt.format(d.tokens.input)}</dd>
        <dt>Output</dt><dd>${intFmt.format(d.tokens.output)}</dd>
        <dt>Reasoning</dt><dd>${intFmt.format(d.tokens.reasoning)}</dd>
        <dt>Cache read</dt><dd>${intFmt.format(d.tokens.cacheRead)}</dd>
        <dt>Cache write</dt><dd>${intFmt.format(d.tokens.cacheWrite)}</dd>
      </dl>
      <h4>Tools</h4>
      ${
        d.tools.length
          ? `<ul class="tools">${d.tools.map((t) => `<li>${escapeHtml(t.name)} <span>×${t.count}</span></li>`).join('')}</ul>`
          : '<p class="state">Sin tool calls.</p>'
      }
      ${why.length ? `<h4>¿Por qué?</h4><ul class="why">${why.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
    `;
    $('drawer-close').addEventListener('click', closeDrawer);
  } catch (err) {
    errorContent(el, err.message);
  }
}

function closeDrawer() {
  const el = $('drawer');
  el.classList.add('hidden');
  el.innerHTML = '';
}

/* ---------- navegación ---------- */
function renderBreadcrumb() {
  const el = $('breadcrumb');
  const parts = ['<button type="button" data-action="root">Proyectos</button>'];
  if (state.projectId) {
    const p = state.data.projects?.items.find((i) => i.id === state.projectId);
    parts.push(`<button type="button" data-action="project">${escapeHtml(p?.label ?? 'proyecto')}</button>`);
  }
  if (state.sessionId) {
    const s = state.data.sessions?.items.find((i) => i.id === state.sessionId);
    parts.push(`<span>${escapeHtml(s?.title || '(sin título)')}</span>`);
  }
  el.innerHTML = parts.join(' <span class="sep">/</span> ');
  el.querySelector('[data-action="root"]')?.addEventListener('click', gotoRoot);
  el.querySelector('[data-action="project"]')?.addEventListener('click', goToProjectLevel);
}

function goToProjectLevel() {
  state.sessionId = null;
  state.data.messages = null;
  const el = $('level-3');
  el.classList.add('hidden');
  el.innerHTML = '';
  closeDrawer();
  renderBreadcrumb();
}

function gotoRoot() {
  state.projectId = null;
  state.sessionId = null;
  state.data.sessions = null;
  state.data.messages = null;
  for (const id of ['level-2', 'level-3']) {
    const el = $(id);
    el.classList.add('hidden');
    el.innerHTML = '';
  }
  closeDrawer();
  renderBreadcrumb();
}

async function openProject(projectId) {
  state.projectId = projectId;
  state.sessionId = null;
  state.data.messages = null;
  $('level-3').classList.add('hidden');
  $('level-3').innerHTML = '';
  closeDrawer();
  renderBreadcrumb();
  await loadSessions(projectId);
}

async function openSession(sessionId) {
  state.sessionId = sessionId;
  closeDrawer();
  renderBreadcrumb();
  await loadMessages(sessionId);
}

/* ---------- refresco ---------- */
async function refreshAll() {
  await loadProjects();
  if (state.projectId) await loadSessions(state.projectId);
  if (state.sessionId) await loadMessages(state.sessionId);
}

function rerenderFromCache() {
  if (state.data.projects) renderProjects();
  if (state.data.sessions) renderSessions();
  if (state.data.messages) renderMessages();
}

/* ---------- eventos ---------- */
$('range-select').addEventListener('change', (e) => {
  state.range = e.target.value;
  refreshAll().catch((err) => showToast(err.message));
});
$('metric-select').addEventListener('change', (e) => {
  state.metric = e.target.value;
  rerenderFromCache();
});
$('subagent-toggle').addEventListener('change', (e) => {
  state.groupByParent = e.target.checked;
  renderSessions();
});
$('refresh').addEventListener('click', () => {
  loadQuota();
  refreshAll().catch((err) => showToast(err.message));
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('drawer').classList.contains('hidden')) return closeDrawer();
  if (state.sessionId) return goToProjectLevel();
  if (state.projectId) return gotoRoot();
});

/* ---------- init ---------- */
loadQuota();
refreshAll().catch((err) => showToast(err.message));
