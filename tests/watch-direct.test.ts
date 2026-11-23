import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TiloriConfig } from '../src/config.ts';
import { writeKey } from '../src/keys.ts';
import { directRouter } from '../src/watch.ts';
import { allowHome } from './allow-home.ts';

// `watch --notify-lines` runs directRouter whenever no router serves the
// agent. It must read the same local wake settings as the `router` command,
// or a shadow day started that way silently runs builtin and records nothing
// (Pax, tilori-agent#162 finding 1). A bad value throwing here shows the key
// is read: before the fix these configs built a router without complaint.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ta-watch-direct-'));
  process.env.TILORI_HOME = join(home, 'tilori');
  allowHome(process.env.TILORI_HOME);
  writeKey('wren', 'mcp_sk_test_value');
});
afterEach(() => {
  delete process.env.TILORI_HOME;
  rmSync(home, { recursive: true, force: true });
});

const build = (agent: Record<string, unknown>) =>
  directRouter({
    agent: 'wren',
    config: { url: 'http://127.0.0.1:9', agents: { wren: agent } } as TiloriConfig,
  });

describe('directRouter reads the local wake settings', () => {
  test('a valid builtin, wakewise or shadow config builds', () => {
    expect(() => build({})).not.toThrow();
    expect(() => build({ wake_engine: 'wakewise' })).not.toThrow();
    expect(() => build({ shadow: true, record_decisions: true })).not.toThrow();
  });

  test('wake_engine and shadow are checked', () => {
    expect(() => build({ wake_engine: 'wakewse' })).toThrow();
    expect(() => build({ shadow: 'yes' })).toThrow();
    expect(() => build({ wake_engine: 'wakewise', shadow: true })).toThrow(/shadow/);
  });

  test('record_decisions is checked', () => {
    expect(() => build({ record_decisions: 'yes' })).toThrow();
  });
});
