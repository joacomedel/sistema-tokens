import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, annotateMessages, annotateSessions, summarizeFlags } from '../lib/causes.mjs';

const msg = (id, { input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cost = 0 }) => ({
  id,
  tokens: {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
    effective: input + output + reasoning,
    cost,
  },
  flags: [],
});

test('percentile nearest-rank', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.75), 8);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([], 0.5), null);
});

test('annotateMessages marca cada causa esperada sin ruido', () => {
  const items = [
    msg('A', { input: 1000, output: 10, reasoning: 0, cacheRead: 0, cost: 0.01 }),
    msg('B', { input: 100, output: 1000, reasoning: 0, cacheRead: 500, cost: 0.005 }),
    msg('C', { input: 100, output: 10, reasoning: 500, cacheRead: 500, cost: 0.003 }),
    msg('D', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.001 }),
    msg('E', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.0015 }),
  ];
  annotateMessages(items);
  const codes = Object.fromEntries(items.map((i) => [i.id, i.flags.map((f) => f.code)]));
  assert.deepEqual(codes.A, ['no_cache']);
  assert.deepEqual(codes.B, ['long_output']);
  assert.deepEqual(codes.C, ['high_reasoning']);
  assert.deepEqual(codes.D, []);
  assert.deepEqual(codes.E, []);
});

test('expensive_model: n>=5, borde exacto y modelos free', () => {
  const set = (costs) => costs.map((c, i) => msg(`m${i}`, { input: 1, cacheRead: 1, cost: c }));

  const five = set([1, 1, 1, 1, 10]);
  annotateMessages(five);
  assert.deepEqual(five[4].flags.map((f) => f.code), ['expensive_model']);
  assert.deepEqual(five[0].flags.map((f) => f.code), []);

  const four = set([1, 1, 1, 10]);
  annotateMessages(four);
  assert.ok(four.every((i) => !i.flags.some((f) => f.code === 'expensive_model')), 'n=4 desactiva la regla');

  const border = set([1, 1, 1, 1, 2]);
  annotateMessages(border);
  assert.deepEqual(border[4].flags.map((f) => f.code), ['expensive_model'], '= 2×mediana marca');

  const free = set([0, 0, 0, 0, 0]);
  annotateMessages(free);
  assert.ok(free.every((i) => i.flags.length === 0), 'cost 0 (free) no marca modelo caro');
});

test('recorte: máximo 2 señales por ítem, ordenadas por prioridad', () => {
  const items = [
    msg('X', { input: 1000, output: 1000, reasoning: 1000, cacheRead: 0, cost: 0.1 }),
    msg('n1', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.001 }),
    msg('n2', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.001 }),
    msg('n3', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.001 }),
    msg('n4', { input: 100, output: 10, reasoning: 0, cacheRead: 500, cost: 0.001 }),
  ];
  annotateMessages(items);
  const X = items[0];
  assert.deepEqual(X.flags.map((f) => f.code), ['no_cache', 'expensive_model']);
  assert.equal(X.flags[0].severity, 0);
  assert.equal(X.flags[1].severity, 1);
  assert.equal(X.flags.length, 2);
});

test('annotateSessions: compacted, many_subagents y summarizeFlags', () => {
  const sess = (id, extra = {}) => ({
    id,
    tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 500, cacheWrite: 0, total: 600, effective: 100, cost: 0 },
    flags: [],
    compacted: false,
    ...extra,
  });
  const items = [sess('sA', { compacted: true }), sess('sB'), sess('sC')];
  const childCounts = new Map([
    ['sB', 5],
    ['sC', 4],
  ]);
  annotateSessions(items, { childCounts });
  assert.deepEqual(items[0].flags.map((f) => f.code), ['compacted']);
  assert.deepEqual(items[1].flags.map((f) => f.code), ['many_subagents']);
  assert.deepEqual(items[2].flags.map((f) => f.code), []);
  assert.deepEqual(summarizeFlags(items), { sessionsWithSignals: 2 });
});

test('sets vacíos y effective 0 no rompen ni generan NaN', () => {
  assert.doesNotThrow(() => annotateMessages([]));
  assert.doesNotThrow(() => annotateSessions([]));
  assert.deepEqual(summarizeFlags([]), { sessionsWithSignals: 0 });

  const zero = [
    msg('z1', { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0.5 }),
    msg('z2', { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0.5 }),
  ];
  annotateMessages(zero);
  assert.ok(zero.every((i) => i.flags.every((f) => Number.isFinite(f.severity))));
  assert.ok(zero.every((i) => !i.flags.some((f) => f.code === 'expensive_model')));
});
