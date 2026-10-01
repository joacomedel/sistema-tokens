import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange } from '../lib/ranges.mjs';

const now = new Date(2026, 9, 1, 12, 0, 0); // 1-oct-2026 12:00 local

test('today: desde medianoche local', () => {
  const r = resolveRange('today', now);
  assert.equal(r.key, 'today');
  assert.equal(r.fromMs, new Date(2026, 9, 1).getTime());
  assert.equal(r.toMs, now.getTime());
  assert.equal(typeof r.label, 'string');
  assert.ok(r.label.length > 0);
});

test('7d: ahora menos 7 días', () => {
  const r = resolveRange('7d', now);
  assert.equal(r.fromMs, now.getTime() - 7 * 86400000);
  assert.equal(r.toMs, now.getTime());
});

test('30d: ahora menos 30 días', () => {
  const r = resolveRange('30d', now);
  assert.equal(r.fromMs, now.getTime() - 30 * 86400000);
  assert.equal(r.toMs, now.getTime());
});

test('month: primer día del mes en curso (distinto de today en mitad de mes)', () => {
  const r = resolveRange('month', now);
  assert.equal(r.fromMs, new Date(2026, 9, 1).getTime());
  const mid = new Date(2026, 9, 15, 12);
  assert.equal(resolveRange('month', mid).fromMs, new Date(2026, 9, 1).getTime());
  assert.notEqual(resolveRange('today', mid).fromMs, resolveRange('month', mid).fromMs);
});

test('all: sin límites y con label', () => {
  const r = resolveRange('all', now);
  assert.equal(r.key, 'all');
  assert.equal(r.fromMs, null);
  assert.equal(r.toMs, null);
  assert.ok(r.label.length > 0);
});

test('range inválido tira Error', () => {
  assert.throws(() => resolveRange('nope', now), /inválido/);
});
