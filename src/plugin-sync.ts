import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { buildMarketUrl, buildMcpUrl, sameEndpoint, type TiloriConfig } from './config.ts';
import { isOtherHome, tiloriHome } from './keys.ts';

/**
 * The Universal Market plugin's two address options, `tilori_url` and `market_url`
 * (UNI-882, design fb13dbe9). Claude Code's `.mcp.json` can only take a server
 * URL from the environment or a plugin option, so a plain `claude` session
 * reaches whatever the options say. tilori-agent is their only writer: every
 * command that records `url` or `market_url` in config.json sets them too,
 * and `sync-plugin` repairs drift.
 *
 * Bastion e7060719:
 * - One way, no input: the values come only from config.json. No argument,
 *   environment variable or repo file chooses them. Each passes the same
 *   shape checks as the plugin's header helper (no credentials, query,
 *   fragment, whitespace or control characters) before it is written.
 * - `claude` is resolved from absolute PATH directories only and run with
 *   cwd `/`, so a repo can't supply it (tilori-agent#98).
 * - Only the two URLs go to `claude plugin configure`, never a key or a key
 *   path, and nothing else from config.json is printed.
 * The key gate is unchanged: a key is released only on an exact match with
 * config.json (UNI-748), so a drifted option means a 401, never a leak.
 */

export const PLUGIN_ID = 'universal-market@tilori-claude';
/** The plugin's stable launcher, written at session start (write-launcher.sh). */
export const LAUNCHER = '~/.claude/plugins/data/universal-market-tilori-claude/tilori-agent';
export const SYNC_COMMAND = `sh ${LAUNCHER} sync-plugin`;

export type OptionName = 'tilori_url' | 'market_url';
export type PluginValues = Partial<Record<OptionName, string>>;

export interface PluginConfig {
  /** The plugin's configured market_url, if set. */
  market_url?: string;
  /** The plugin's default market_url (production). */
  market_default?: string;
  /** The plugin's configured tilori_url, if set. */
  tilori_url?: string;
  /** The plugin's default tilori_url (production). */
  tilori_default?: string;
}

/**
 * The absolute path of `claude` from PATH, skipping relative and empty PATH
 * entries. Claude Code now starts in the caller's project directory, and
 * spawn resolves a bare name against that cwd, so a relative entry would let
 * a `claude` file in the project run instead (Pax 833f4521). Works under
 * Bun, Node and the compiled binary alike. Moved here from cli.ts (UNI-882)
 * so `claude plugin configure` resolves it the same way.
 */
export function claudeBinary(path = process.env.PATH ?? ''): string {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try {
      const st = statSync(candidate);
      if (st.isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  throw new Error('Could not start claude: no claude executable in an absolute PATH directory.');
}

/** Runs `claude plugin configure <plugin> …` from `/` with `input` on
 * stdin; resolves to its stdout, or null when it can't run or fails. Nothing
 * secret is ever passed. */
function claudePlugin(args: string[], input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(claudeBinary(), ['plugin', 'configure', PLUGIN_ID, ...args], { stdio: ['pipe', 'pipe', 'ignore'], cwd: '/' });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', () => resolve(null));
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
    child.stdin.end(input ?? '');
  });
}

export async function readPluginConfigFromClaude(): Promise<PluginConfig | null> {
  const raw = await claudePlugin(['--json']);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      market_url: str(j?.inputs?.market_url),
      market_default: str(j?.schema?.market_url?.default),
      tilori_url: str(j?.inputs?.tilori_url),
      tilori_default: str(j?.schema?.tilori_url?.default),
    };
  } catch {
    return null;
  }
}

/** Sets the given options; options left out keep their values. Resolves to
 * an error word, or null on success. */
export async function configurePluginWithClaude(values: PluginValues): Promise<string | null> {
  const ok = await claudePlugin(['--values-stdin'], JSON.stringify(values));
  return ok === null ? 'failed' : null;
}

export interface PluginIO {
  read: () => Promise<PluginConfig | null>;
  configure: (values: PluginValues) => Promise<string | null>;
}

let io: PluginIO = { read: readPluginConfigFromClaude, configure: configurePluginWithClaude };

/** Swaps the Claude Code access, for tests (tests/setup.ts sets a fake for
 * every test, so no test runs the real `claude`). Returns the previous one. */
export function setPluginIO(next: PluginIO): PluginIO {
  const prev = io;
  io = next;
  return prev;
}

/** A URL fit to hand to the plugin: what the header helper would accept
 * (UNI-860/867), as one line. Throws otherwise. */
function plain(raw: string, url: URL, what: string): string {
  if (/[\s\x00-\x1f\x7f]/.test(raw.trim()) || url.search || url.hash || url.username || url.password) {
    throw new Error(`The ${what} URL in config.json has a query, fragment, credentials, whitespace or control characters; fix it with tilori-agent init.`);
  }
  return url.href;
}

/** The option values config.json implies: always tilori_url, and market_url
 * when config.json has one. Throws on an unusable URL. */
export function wantedValues(config: TiloriConfig): PluginValues {
  if (!config.url) throw new Error('No "url" in config.json; run tilori-agent init --url <tilori-mcp-url> first.');
  const values: PluginValues = { tilori_url: plain(config.url, buildMcpUrl(config.url), 'Tilori') };
  if (config.market_url) values.market_url = plain(config.market_url, buildMarketUrl(config.market_url), 'Market');
  return values;
}

/** An option value as it may be shown: origin and path of a parsable URL,
 * never its query, fragment or credentials (a stray value may carry them). */
function shown(v: string | undefined): string {
  if (!v?.trim()) return '(unset)';
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '(not a URL)';
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

function matches(current: string | undefined, wanted: string): boolean {
  if (!current?.trim()) return false;
  try {
    return sameEndpoint(buildMcpUrl(current), new URL(wanted)) && !new URL(current.trim()).search;
  } catch {
    return false;
  }
}

export const SYNC_LINES = {
  otherHome: (home: string) =>
    `The Universal Market plugin's options serve the default Tilori home, and this is ${home}. Start this home's sessions with \`sh ${LAUNCHER} claude --home ${home}\` instead; it passes this home's URLs to Claude Code.`,
  unread:
    "Couldn't read the Universal Market plugin's options. Is Claude Code installed, with the Universal Market plugin? Install it, then run this again.",
  byHand: (values: PluginValues) =>
    `Couldn't set the Universal Market plugin's options. Run this in a terminal, then restart Claude Code:\n  echo '${JSON.stringify(values).replaceAll("'", `'\\''`)}' | claude plugin configure ${PLUGIN_ID} --values-stdin`,
  same: 'The Universal Market plugin already uses the URLs in config.json; nothing to change.',
  changed: (name: OptionName, from: string, to: string) => `${name}: ${from} → ${to}`,
  unchanged: (name: OptionName) => `${name} unchanged`,
  noMarket: 'market_url: config.json has none, so the option was left as it is.',
  restart: 'Restart Claude Code (quit, then run claude again) to use them.',
};

/**
 * Sets the plugin's options to config.json's URLs. Returns the lines to show
 * and an exit code: 0 done or nothing to do, 1 Claude Code or the plugin
 * couldn't be read or written, 2 this isn't the default home or config.json
 * has no usable URL.
 */
export async function syncPlugin(config: TiloriConfig): Promise<{ code: number; lines: string[]; changed: boolean }> {
  if (isOtherHome()) return { code: 2, lines: [SYNC_LINES.otherHome(tiloriHome())], changed: false };
  let wanted: PluginValues;
  try {
    wanted = wantedValues(config);
  } catch (cause) {
    return { code: 2, lines: [cause instanceof Error ? cause.message : String(cause)], changed: false };
  }
  const current = await io.read();
  if (!current) return { code: 1, lines: [SYNC_LINES.unread], changed: false };
  const now: Record<OptionName, string | undefined> = {
    tilori_url: current.tilori_url ?? current.tilori_default,
    market_url: current.market_url ?? current.market_default,
  };
  const change: PluginValues = {};
  const lines: string[] = [];
  for (const name of ['tilori_url', 'market_url'] as const) {
    const want = wanted[name];
    if (want === undefined) lines.push(SYNC_LINES.noMarket);
    else if (matches(now[name], want)) lines.push(SYNC_LINES.unchanged(name));
    else {
      change[name] = want;
      lines.push(SYNC_LINES.changed(name, shown(now[name]), want));
    }
  }
  if (!Object.keys(change).length) return { code: 0, lines: [SYNC_LINES.same], changed: false };
  if (await io.configure(change)) return { code: 1, lines: [SYNC_LINES.byHand(change)], changed: false };
  return { code: 0, lines: [...lines, SYNC_LINES.restart], changed: true };
}

/**
 * After a command recorded URLs in config.json (init, setup): set the
 * plugin's options to match, when this is the default home and Claude Code
 * with the plugin is there. Quiet when nothing changed or the plugin isn't
 * installed (a Codex-only machine); otherwise the lines to show.
 */
export async function syncPluginAfterSave(config: TiloriConfig): Promise<string[]> {
  if (isOtherHome()) return [];
  const r = await syncPlugin(config);
  if (r.changed) return ['The Universal Market plugin now uses these URLs:', ...r.lines];
  if (r.code === 1 && r.lines[0] !== SYNC_LINES.unread) return r.lines; // the plugin is there but refused
  return [];
}
