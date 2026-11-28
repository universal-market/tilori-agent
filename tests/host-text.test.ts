import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostText, type HostText } from '../src/host-text.ts';
import { claudeText } from '../src/hosts/claude/text.ts';

// UNI-1178 S1a: the claude HostText table. Every key is required by the type
// (a missing key fails tsc); these tests check what the type cannot: the table
// never says Codex, no value is empty, and today's strings are pinned in a
// readable snapshot so a wording change shows up as a reviewable diff.
// UPDATE_HOST_TEXT=1 rewrites the snapshot.

const SNAPSHOT = join(import.meta.dir, 'snapshots', 'host-text', 'claude.txt');

// Fixed sample arguments, so every function key renders to one string.
const SAMPLE = ['<a1>', '<a2>', '<a3>'];

/** Renders every key: strings as they are, functions applied to SAMPLE. */
function render(table: HostText): Array<[string, string]> {
  return Object.entries(table).map(([key, v]) => {
    const out = typeof v === 'function' ? (v as (...a: string[]) => string)(...SAMPLE.slice(0, v.length)) : v;
    return [key, Array.isArray(out) ? out.join('\n') : String(out)];
  });
}

describe('claude HostText table', () => {
  test('the accessor returns the claude table', () => {
    expect(hostText()).toBe(claudeText);
  });

  test('the claude table never says Codex', () => {
    for (const [key, value] of render(claudeText)) expect({ key, codex: /codex/i.test(value) }).toEqual({ key, codex: false });
  });

  test('no value is empty (every key is filled in)', () => {
    for (const [key, value] of render(claudeText)) expect({ key, empty: value.trim() === '' }).toEqual({ key, empty: false });
  });

  test('function keys take their sample arguments into the output', () => {
    for (const [key, v] of Object.entries(claudeText))
      if (typeof v === 'function' && v.length > 0) {
        const out = String((v as (...a: string[]) => unknown)(...SAMPLE.slice(0, v.length)));
        expect({ key, uses: out.includes('<a1>') }).toEqual({ key, uses: true });
      }
  });

  test('claude.txt: the table is snapshotted', () => {
    const actual = render(claudeText)
      .map(([k, v]) => `### ${k}\n${v}\n`)
      .join('\n');
    if (process.env.UPDATE_HOST_TEXT === '1') {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, actual);
      return;
    }
    if (!existsSync(SNAPSHOT)) throw new Error('missing snapshot host-text/claude.txt; run with UPDATE_HOST_TEXT=1 to create it');
    expect(actual).toBe(readFileSync(SNAPSHOT, 'utf8'));
  });
});
