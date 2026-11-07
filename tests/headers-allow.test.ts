import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEADERS_ALLOW, headersAllowText, releasedEndpoint, saveConfig } from '../src/config.ts';
import { writeKey } from '../src/keys.ts';
import { allowHome } from './allow-home.ts';

// UNI-769: the plugin's sh-only headersHelper releases a key only on an
// exact line match in headers.allow, so every URL listed there must be one
// `headers` itself would release to.

const KEY = 'mcp_sk_headers_allow_secret';
let home: string;
let th: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tilori-agent-test-'));
  th = join(home, 'tilori');
  process.env.TILORI_HOME = th;
  allowHome(th);
  delete process.env.TILORI_AGENT;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
});

const read = () => readFileSync(join(th, HEADERS_ALLOW), 'utf8');

describe('headers.allow', () => {
  test('saveConfig writes it at 0600 with a default line and one line per agent and URL', () => {
    writeKey('wren', KEY);
    writeKey('keel', KEY);
    saveConfig({
      url: 'https://tilori.example/mcp/tilori/v1',
      market_url: 'https://market.example/mcp/v1',
      default_agent: 'wren',
    });
    const path = join(th, HEADERS_ALLOW);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read()).toBe(
      [
        'default wren',
        'keel https://tilori.example/mcp/tilori/v1',
        'keel https://market.example/mcp/v1',
        'wren https://tilori.example/mcp/tilori/v1',
        'wren https://market.example/mcp/v1',
        '',
      ].join('\n'),
    );
    expect(read()).not.toContain(KEY);
  });

  test('lists both the URL as written and normalized, and every listed URL is one headers releases to', () => {
    const config = { url: 'https://tilori.example', market_url: 'https://market.example/mcp/v1/', default_agent: 'wren' };
    const text = headersAllowText(config, ['wren']);
    const urls = text
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('default '))
      .map((l) => l.split(' ')[1]!);
    expect(urls).toEqual([
      'https://tilori.example',
      'https://tilori.example/mcp/tilori/v1',
      'https://market.example/mcp/v1/',
    ]);
    for (const u of urls) expect(releasedEndpoint(config, u)).not.toBeNull();
  });

  test('a URL headers would refuse is left out', () => {
    const text = headersAllowText(
      { url: 'http://tilori.example/mcp/tilori/v1', market_url: 'https://market.example/other', default_agent: 'wren' },
      ['wren'],
    );
    expect(text).toBe('default wren\n');
  });

  test('without key files or a default it lists nothing', () => {
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1' });
    expect(read()).toBe('');
  });

  test('an invalid default_agent gets no default line', () => {
    expect(headersAllowText({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'bad agent;x' }, [])).toBe('');
  });

  test('is rewritten on every save, so a removed market_url drops its lines', () => {
    writeKey('wren', KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', market_url: 'https://market.example/mcp/v1', default_agent: 'wren' });
    expect(read()).toContain('market.example');
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren' });
    expect(read()).toBe('default wren\nwren https://tilori.example/mcp/tilori/v1\n');
  });

  test('is never older than config.json', () => {
    writeKey('wren', KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren' });
    const config = statSync(join(th, 'config.json')).mtimeMs;
    expect(statSync(join(th, HEADERS_ALLOW)).mtimeMs).toBeGreaterThanOrEqual(config);
  });
});
