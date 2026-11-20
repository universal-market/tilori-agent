import './setup.ts';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionRecorder, RECORDER_MAX_EVENTS } from '../src/recorder.ts';
import { recordDecisions, recorderConfig } from '../src/config.ts';

// UNI-1097 slice 4: the opt-in decision recorder.
const ID = '11111111-2222-4333-8444-555555555555';
const base = () => join(mkdtempSync(join(tmpdir(), 'tilori-recorder-')), 'rec');
const ev = (kind = 'post.created', entity_type = 'post', entity_id = ID) => ({ kind, entity_type, entity_id });
const read = (r: DecisionRecorder) =>
  readFileSync(r.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a line has only the fixed fields; the file is 0600 in a 0700 directory', () => {
  const dir = base();
  const r = new DecisionRecorder(dir, 'wren', { now: () => Date.UTC(2026, 10, 20) });
  r.record({ decision: 'wake', lane: 'direct', events: [ev('mention')] });
  expect(read(r)).toEqual([
    { at: '2026-11-20T00:00:00.000Z', recipient: 'wren', decision: 'wake', lane: 'direct', events: [{ kind: 'mention', entity_type: 'post', id: ID }] },
  ]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(r.path).mode & 0o777).toBe(0o600);
});

test('free text never reaches the file: odd kinds and ids are replaced', () => {
  const r = new DecisionRecorder(base(), 'wren');
  r.record({ decision: 'drop', lane: null, events: [ev('Secret Title!', 'SECRET', 'my private title')] });
  const text = readFileSync(r.path, 'utf8');
  expect(text).not.toMatch(/secret|private/i);
  expect(read(r)[0].events).toEqual([{ kind: 'other', entity_type: 'other', id: 'invalid-id' }]);
});

test('long batches are cut and counted', () => {
  const r = new DecisionRecorder(base(), 'wren');
  r.record({ decision: 'hold', lane: null, events: Array.from({ length: RECORDER_MAX_EVENTS + 5 }, () => ev()) });
  const line = read(r)[0];
  expect(line.events).toHaveLength(RECORDER_MAX_EVENTS);
  expect(line.more).toBe(5);
});

test('a bad handle is refused up front', () => {
  for (const h of ['', '../x', 'a/b', 'A', 'a b']) expect(() => new DecisionRecorder(base(), h)).toThrow();
});

test('the size cap drops the oldest lines and keeps the file under the cap', () => {
  const r = new DecisionRecorder(base(), 'wren', { maxBytes: 1500 });
  for (let i = 0; i < 30; i++) r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  expect(r.disabled).toBe(false);
  expect(statSync(r.path).size).toBeLessThanOrEqual(1500);
  expect(read(r).length).toBeGreaterThan(0);
});

test('the age cap drops old lines when the file is pruned', () => {
  let t = Date.UTC(2026, 10, 1);
  const r = new DecisionRecorder(base(), 'wren', { maxBytes: 700, maxAgeMs: 3600_000, now: () => t });
  for (let i = 0; i < 3; i++) r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  t += 2 * 3600_000;
  for (let i = 0; i < 3; i++) r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  const ats = read(r).map((l) => Date.parse(l.at));
  expect(Math.min(...ats)).toBeGreaterThanOrEqual(t - 3600_000);
});

test('a symlinked recording is never followed: recording stops, once, and nothing throws', () => {
  const dir = base();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, 'elsewhere');
  writeFileSync(target, 'keep\n', { mode: 0o600 });
  symlinkSync(target, join(dir, 'wren.jsonl'));
  const errors: string[] = [];
  const r = new DecisionRecorder(dir, 'wren', { onError: (m) => errors.push(m) });
  r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  expect(r.disabled).toBe(true);
  expect(errors).toHaveLength(1);
  expect(readFileSync(target, 'utf8')).toBe('keep\n');
});

test('a group- or world-readable recording file stops recording', () => {
  const dir = base();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, 'wren.jsonl');
  writeFileSync(f, '', { mode: 0o600 });
  chmodSync(f, 0o644);
  const errors: string[] = [];
  const r = new DecisionRecorder(dir, 'wren', { onError: (m) => errors.push(m) });
  r.record({ decision: 'wake', lane: 'normal', events: [ev()] });
  expect(r.disabled).toBe(true);
  expect(errors[0]).toContain('readable by other users');
  expect(readFileSync(f, 'utf8')).toBe('');
});

test('a directory where the file should be disables recording without throwing', () => {
  const dir = base();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'wren.jsonl'));
  const errors: string[] = [];
  const r = new DecisionRecorder(dir, 'wren', { onError: (m) => errors.push(m) });
  expect(() => r.record({ decision: 'wake', lane: null, events: [ev()] })).not.toThrow();
  expect(errors).toHaveLength(1);
});

test('an unknown decision is ignored', () => {
  const r = new DecisionRecorder(base(), 'wren');
  r.record({ decision: 'bogus' as never, lane: null, events: [ev()] });
  expect(existsSync(r.path)).toBe(false);
});

test('record_decisions: only true or false; unset is off', () => {
  expect(recordDecisions(undefined)).toBe(false);
  expect(recordDecisions(true)).toBe(true);
  expect(recordDecisions(false)).toBe(false);
  for (const v of ['yes', 1, null, 'true']) expect(() => recordDecisions(v)).toThrow('true or false');
  expect(recorderConfig({ agents: { wren: { record_decisions: true } } } as never, 'wren')).toEqual({ recordDecisions: true });
  expect(recorderConfig({ agents: { wren: {} } } as never, 'wren')).toEqual({});
  expect(recorderConfig({} as never, 'wren')).toEqual({});
});
