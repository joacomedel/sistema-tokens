import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLDS } from '../src/analyze/thresholds.mjs';
import { sumMetrics, percentile, topShare } from '../src/analyze/aggregate.mjs';

test('THRESHOLDS tiene los valores calibrados', () => {
  assert.equal(THRESHOLDS.noCacheInput, 8000);
  assert.equal(THRESHOLDS.longOutput, 1000);
  assert.equal(THRESHOLDS.highReasoningShare, 0.25);
  assert.equal(THRESHOLDS.costConcentrationShare, 0.5);
  assert.equal(THRESHOLDS.costConcentrationMinChildren, 5);
});

test('sumMetrics acumula y redondea el costo', () => {
  const m = sumMetrics([
    { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0, total: 115, effective: 15, cost: 0.001 },
    { input: 20, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 26, effective: 26, cost: 0.002 },
  ]);
  assert.equal(m.effective, 41);
  assert.equal(m.cost, 0.003);
});

test('percentile usa nearest-rank', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(percentile([], 90), 0);
});

test('topShare suma los k mayores', () => {
  assert.equal(topShare([1, 1, 1, 7], 3), 9 / 10);
  assert.equal(topShare([], 3), 0);
});
