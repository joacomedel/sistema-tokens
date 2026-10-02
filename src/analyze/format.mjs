const compact = new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(n) {
  return compact.format(n ?? 0);
}

export function formatUsd(n) {
  const v = n ?? 0;
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

/** Listado compacto de findings para el texto del tool. */
export function formatFindings(findings) {
  if (!findings.length) return 'Sin hallazgos para este scope.';
  return findings
    .map((f) => {
      const subject = f.subject?.label ? `${f.subject.label}: ` : '';
      return `- [${f.severity}] ${f.code} (${f.share_pct}%) — ${subject}${f.hypothesis}`;
    })
    .join('\n');
}
