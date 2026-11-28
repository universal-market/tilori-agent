import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { hostTextReads } from '../src/host-text.ts';

// UNI-1178 S1b (Pax's S1a note): the host's words are read when a line is
// used, after the host is chosen, never while a core module loads. Each module
// is imported as a fresh instance (a query string makes Bun evaluate its top
// level again) and the read counter must not move; then a line is used and
// the counter must move, so the test cannot pass by counting nothing.
const dir = import.meta.dir + '/../src/';
const fresh = (name: string) => import(`${dir}${name}.ts?lazy=${name}`);

describe('importing core does not read the host text table', () => {
  for (const name of ['activity', 'cli', 'connect', 'plugin-sync', 'setup', 'host', 'host-text']) {
    test(`${name}.ts`, async () => {
      const before = hostTextReads();
      await fresh(name);
      expect(hostTextReads()).toBe(before);
    });
  }

  test('using a line reads the table (the counter works)', async () => {
    const connect = await fresh('connect');
    const setup = await fresh('setup');
    const sync = await fresh('plugin-sync');
    const before = hostTextReads();
    expect(typeof connect.CONNECT_LINES.noKey).toBe('string');
    expect(typeof connect.CONNECT_LINES.restart).toBe('object');
    expect(typeof setup.LINES.timeout).toBe('string');
    expect(typeof sync.SYNC_LINES.unread).toBe('string');
    expect(hostTextReads()).toBeGreaterThanOrEqual(before + 4);
  });
});
