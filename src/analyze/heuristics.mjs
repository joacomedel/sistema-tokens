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

  return findings.sort((a, b) => b.share_pct - a.share_pct);
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
