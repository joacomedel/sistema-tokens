import { THRESHOLDS } from './thresholds.mjs';
import { topShare } from './aggregate.mjs';

const HYPOTHESES = {
  no_cache_input: 'Input grande sin cache: se vuelve a pagar el contexto completo; revisar por qué no se reutiliza el cache.',
  low_cache_hit: 'Contexto grande con poco cache hit: el prompt cambia de más o el cache no aplica; recortar contexto estable.',
  long_output: 'Output muy largo: pedir respuestas más concisas o acotar el alcance.',
  high_reasoning_share: 'Mucho razonamiento sobre tokens efectivos: prompts ambiguos o tarea de más; aclarar el pedido.',
  expensive_model_mismatch: 'Modelo caro para una respuesta corta: evaluar un modelo más barato para esa tarea.',
  cost_concentration: 'Pocos hijos concentran casi todo el gasto; enfocar la optimización ahí antes que en el resto.',
  subagent_fanout: 'Muchos subagentes bajo el mismo padre: contexto repetido; evaluar hacerlo en una sola sesión.',
  repeated_tool_calls: 'Múltiples llamadas idénticas a la misma tool: posible loop o re-lecturas innecesarias; revisar si se puede cachear o agrupar.',
  compaction_overhead: 'Sesión compactada con costo alto: la compactación no redujo suficiente el gasto; revisar gestión de contexto.',
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

function severityFor(sharePct) {
  if (sharePct >= 10) return 'high';
  if (sharePct >= 3) return 'medium';
  return 'low';
}

function worst(messages) {
  return messages.reduce((best, m) => ((m.tokens?.cost ?? 0) > (best.tokens?.cost ?? 0) ? m : best), messages[0]);
}

const RULES = [
  {
    code: 'no_cache_input',
    hit: (t, th) => t.input >= th.noCacheInput && t.cacheRead <= t.input * th.cacheReadLowRatio,
  },
  {
    code: 'low_cache_hit',
    hit: (t, th) => {
      const context = t.cacheRead + t.input;
      return context >= th.largeContext && t.cacheRead / context < th.lowCacheHitRatio;
    },
  },
  { code: 'long_output', hit: (t, th) => t.output >= th.longOutput },
  {
    code: 'high_reasoning_share',
    hit: (t, th) => t.effective > 0 && t.reasoning / t.effective >= th.highReasoningShare,
  },
  {
    code: 'expensive_model_mismatch',
    hit: (t, th) => t.cost >= th.expensiveCostPerMessage && t.output < th.shortOutput,
  },
];

/**
 * Evalúa las reglas por mensaje y agrupa por código. Devuelve findings con
 * evidencia numérica; el peor mensaje de cada regla es el `subject`.
 */
export function analyzeMessages(messages, { thresholds = THRESHOLDS } = {}) {
  const totalCost = messages.reduce((a, m) => a + (m.tokens?.cost ?? 0), 0);
  const findings = [];

  for (const rule of RULES) {
    const affected = messages.filter((m) => m.tokens && rule.hit(m.tokens, thresholds));
    if (!affected.length) continue;
    const cost = affected.reduce((a, m) => a + (m.tokens?.cost ?? 0), 0);
    const sharePct = totalCost > 0 ? round1((cost / totalCost) * 100) : 0;
    const subject = worst(affected);
    findings.push({
      code: rule.code,
      severity: severityFor(sharePct),
      share_pct: sharePct,
      subject: { type: 'message', id: subject.id, label: subject.label ?? subject.id },
      evidence: { messages: affected.length, cost: Math.round(cost * 1e6) / 1e6 },
      hypothesis: HYPOTHESES[rule.code],
    });
  }

  // repeated_tool_calls: requiere datos de tools por mensaje (getMessageDetail)
  const repeatedFindings = analyzeRepeatedToolCalls(messages, thresholds);
  findings.push(...repeatedFindings);

  return findings.sort((a, b) => b.share_pct - a.share_pct);
}

/**
 * Detecta mensajes con >= N llamadas idénticas a la misma tool.
 * Requiere que los mensajes incluyan `tools: [{ name, count }]`.
 */
function analyzeRepeatedToolCalls(messages, thresholds) {
  const totalCost = messages.reduce((a, m) => a + (m.tokens?.cost ?? 0), 0);
  const findings = [];

  // Agrupar por tool name: contar mensajes afectados y costo total
  const byTool = new Map();
  for (const m of messages) {
    if (!m.tools) continue;
    for (const t of m.tools) {
      if (t.count < thresholds.repeatedToolCalls) continue;
      if (!byTool.has(t.name)) byTool.set(t.name, { tool: t.name, count: t.count, messages: [], cost: 0 });
      const entry = byTool.get(t.name);
      entry.messages.push(m);
      entry.cost += m.tokens?.cost ?? 0;
      entry.count = Math.max(entry.count, t.count);
    }
  }

  for (const entry of byTool.values()) {
    const sharePct = totalCost > 0 ? round1((entry.cost / totalCost) * 100) : 0;
    const subject = worst(entry.messages);
    findings.push({
      code: 'repeated_tool_calls',
      severity: severityFor(sharePct),
      share_pct: sharePct,
      subject: { type: 'message', id: subject.id, label: subject.label ?? subject.id },
      evidence: { tool: entry.tool, count: entry.count, messages: entry.messages.length, cost: Math.round(entry.cost * 1e6) / 1e6 },
      hypothesis: HYPOTHESES.repeated_tool_calls,
    });
  }

  return findings;
}

const costOf = (child) => child.cost ?? child.tokens?.cost ?? 0;

/** Concentración de costo en los top-3 hijos, solo si hay suficientes hijos. */
export function analyzeConcentration(children, { thresholds = THRESHOLDS } = {}) {
  if (children.length < thresholds.costConcentrationMinChildren) return null;
  const costs = children.map(costOf);
  const share = topShare(costs, 3);
  if (share < thresholds.costConcentrationShare) return null;
  const subject = children.reduce((best, c) => (costOf(c) > costOf(best) ? c : best), children[0]);
  const sharePct = round1(share * 100);
  return {
    code: 'cost_concentration',
    severity: severityFor(sharePct),
    share_pct: sharePct,
    subject: { type: subject.type, id: subject.id, label: subject.label ?? subject.id },
    evidence: { children: children.length, top3_pct: sharePct },
    hypothesis: HYPOTHESES.cost_concentration,
  };
}

/** Fan-out: un mismo padre con demasiados subagentes. */
export function analyzeFanout(sessions, { thresholds = THRESHOLDS } = {}) {
  const counts = new Map();
  for (const s of sessions) {
    if (!s.parentId) continue;
    counts.set(s.parentId, (counts.get(s.parentId) ?? 0) + 1);
  }
  let parentId = null;
  let max = 0;
  for (const [id, n] of counts) {
    if (n > max) {
      max = n;
      parentId = id;
    }
  }
  if (max < thresholds.subagentFanout) return null;
  const sharePct = sessions.length > 0 ? round1((max / sessions.length) * 100) : 0;
  return {
    code: 'subagent_fanout',
    severity: severityFor(sharePct),
    share_pct: sharePct,
    subject: { type: 'session', id: parentId, label: parentId },
    evidence: { subagents: max },
    hypothesis: HYPOTHESES.subagent_fanout,
  };
}

/**
 * Detecta sesiones compactadas con costo alto relativo a la mediana del scope.
 * `sessions` = [{ id, cost, compacted }]
 */
export function analyzeCompaction(sessions, { thresholds = THRESHOLDS } = {}) {
  if (!sessions.length) return null;
  const costs = sessions.map((s) => s.cost ?? 0).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)] ?? 0;
  if (median <= 0) return null;

  const compacted = sessions.filter((s) => s.compacted && (s.cost ?? 0) >= median * thresholds.compactionCostRatio);
  if (!compacted.length) return null;

  const subject = compacted.reduce((best, s) => ((s.cost ?? 0) > (best.cost ?? 0) ? s : best), compacted[0]);
  const totalCost = sessions.reduce((a, s) => a + (s.cost ?? 0), 0);
  const sharePct = totalCost > 0 ? round1(((subject.cost ?? 0) / totalCost) * 100) : 0;

  return {
    code: 'compaction_overhead',
    severity: severityFor(sharePct),
    share_pct: sharePct,
    subject: { type: 'session', id: subject.id, label: subject.label ?? subject.id },
    evidence: { compacted: true, cost: subject.cost ?? 0, median: Math.round(median * 1e6) / 1e6 },
    hypothesis: HYPOTHESES.compaction_overhead,
  };
}
