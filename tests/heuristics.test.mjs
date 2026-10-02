import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessages, analyzeConcentration, analyzeFanout } from '../src/analyze/heuristics.mjs';

const msg = (id, tokens) => ({
  id,
  label: `#${id}`,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, effective: 0, cost: 0, ...tokens },
});

test('detecta no_cache_input', () => {
  const findings = analyzeMessages([msg('m1', { input: 20000, cacheRead: 0, cost: 0.5 })]);
  const f = findings.find((x) => x.code === 'no_cache_input');
  assert.ok(f);
  assert.equal(f.subject.id, 'm1');
  assert.equal(f.severity, 'high');
});

test('detecta long_output y high_reasoning_share', () => {
  const findings = analyzeMessages([
    msg('m1', { output: 5000, effective: 5000, cost: 0.1 }),
    msg('m2', { output: 10, reasoning: 900, effective: 1000, cost: 0.1 }),
  ]);
  assert.ok(findings.some((f) => f.code === 'long_output'));
  assert.ok(findings.some((f) => f.code === 'high_reasoning_share'));
});

test('analyzeMessages no dispara con valores normales', () => {
  assert.deepEqual(analyzeMessages([msg('m1', { input: 100, cacheRead: 9900, output: 50, effective: 150, cost: 0.0001 })]), []);
});

test('concentración necesita >= 5 hijos y comparte >= 50%', () => {
  const children = [
    { type: 'turn', id: 'a', label: 'A', cost: 8 },
    { type: 'turn', id: 'b', label: 'B', cost: 1 },
    { type: 'turn', id: 'c', label: 'C', cost: 1 },
    { type: 'turn', id: 'd', label: 'D', cost: 0 },
    { type: 'turn', id: 'e', label: 'E', cost: 0 },
  ];
  const f = analyzeConcentration(children);
  assert.ok(f);
  assert.equal(f.code, 'cost_concentration');
  assert.equal(f.subject.id, 'a');
  assert.equal(analyzeConcentration(children.slice(0, 4)), null);
});

test('fanout exige >= 5 subagentes del mismo padre', () => {
  const kids = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, parentId: 'p' }));
  const f = analyzeFanout(kids);
  assert.ok(f);
  assert.equal(f.evidence.subagents, 5);
  assert.equal(analyzeFanout(kids.slice(0, 4)), null);
});
