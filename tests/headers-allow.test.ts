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

  test('a bare market origin lists only its completed endpoint (Pax a89e3b48, Bastion fdbaf264)', () => {
    const config = { url: 'https://t.example/mcp/tilori/v1', market_url: 'https://m.example', default_agent: 'a' };
    expect(headersAllowText(config, ['a'])).toBe(
      ['default a', 'a https://t.example/mcp/tilori/v1', 'a https://m.example/mcp/v1', ''].join('\n'),
    );
  });

  test('every line it writes is a URL releasedEndpoint accepts, across URL spellings', () => {
    const spellings = [
      'https://t.example',
      'https://t.example/',
      'https://t.example/mcp/tilori/v1',
      'https://t.example/mcp/tilori/v1/',
      'HTTPS://T.EXAMPLE:443/mcp/tilori/v1',
      'https://t.example/mcp/tilori/v1?x=1#f',
      'https://m.example',
      'https://m.example/',
      'https://m.example.convex.site',
      'https://m.example/mcp/v1',
      'https://m.example/mcp/v1/',
      'HTTPS://M.EXAMPLE:443/mcp/v1',
      'https://m.example/mcp/v1?x=1#f',
      'http://127.0.0.1:3210',
      'http://localhost:3210/mcp/v1',
      'http://t.example/mcp/tilori/v1',
      'https://user:pw@t.example/mcp/tilori/v1',
      'https://m.example/other',
    ];
    let lines = 0;
    for (const url of spellings)
      for (const market_url of [undefined, ...spellings]) {
        const config = { url, market_url, default_agent: 'a' };
        for (const line of headersAllowText(config, ['a', 'b']).trim().split('\n')) {
          if (!line || line.startsWith('default ')) continue;
          const u = line.split(' ')[1]!;
          expect([u, releasedEndpoint(config, u)]).not.toEqual([u, null]);
          lines++;
        }
      }
    expect(lines).toBeGreaterThan(100);
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
