import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { PluginConfig, PluginIO, PluginValues } from '../../host.ts';
import { claudeText } from './text.ts';

// UNI-1178 S1b: the Claude Code side of the plugin-options mirror, moved here
// unchanged from src/plugin-sync.ts. The policy (Bastion e7060719: values only
// from config.json, `claude` from absolute PATH dirs, cwd `/`, only the two
// URLs on stdin, never a key) is in src/plugin-sync.ts's header; the code that
// enforces the process side is below.

export const PLUGIN_ID = 'universal-market@tilori-claude';
/** The plugin's stable launcher, written at session start (write-launcher.sh). */
export const LAUNCHER = '~/.claude/plugins/data/universal-market-tilori-claude/tilori-agent';
export const SYNC_COMMAND = `sh ${LAUNCHER} sync-plugin`;

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
  throw new Error(claudeText.noLauncherBinary);
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

export const claudePluginIO: PluginIO = {
  pluginId: PLUGIN_ID,
  launcher: LAUNCHER,
  read: readPluginConfigFromClaude,
  configure: configurePluginWithClaude,
};
