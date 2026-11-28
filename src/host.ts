// The core/host seam (UNI-1178 design section 2, S1b). Core code talks to the
// host (Claude Code today, Codex later) only through this interface and the
// accessor below. The one place core imports a host is the adapter entry point
// (src/hosts/claude/index.ts); tests/core-imports.test.ts enforces that.
import { claudeAdapter } from './hosts/claude/index.ts';
import type { HostText } from './host-text.ts';

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

/** Host config mirror: reads and writes the host plugin's two address options
 * (Claude: `claude plugin configure`). Nothing secret ever passes through it. */
export interface PluginIO {
  /** The plugin's id as the host names it, for the by-hand fix lines. */
  pluginId: string;
  /** The plugin's stable launcher path, for the lines that tell a user to run it. */
  launcher: string;
  /** The plugin's options; null when the host or the plugin isn't there. */
  read: () => Promise<PluginConfig | null>;
  /** Sets the given options; resolves to an error word, or null on success. */
  configure: (values: PluginValues) => Promise<string | null>;
}

/** Host permission-rule check: one fixed warning line, or null. Reads only; never edits. */
export interface RuleCheck {
  check: (env: NodeJS.ProcessEnv) => string | null;
}

/** The slice of the design's HostAdapter that S1a-b move behind the seam. Delivery,
 * identity, hooks and the rest arrive with S1c and S3. `pluginIO` and `ruleCheck`
 * become optional when a host without them (Codex) exists. */
export interface HostAdapter {
  /** 'claude' | 'codex'; host names live only under src/hosts/**. */
  id: string;
  /** Every user-facing host-named string. */
  text: HostText;
  pluginIO: PluginIO;
  ruleCheck: RuleCheck;
  /** Absolute path of the host's CLI binary, resolved from absolute PATH dirs only (S1c: moves with the launcher). */
  binary: (path?: string) => string;
}

let active: HostAdapter | null = null;

/** The chosen host's adapter. Nothing reads the adapter's tables at import
 * time; the host is fixed to Claude until a second one exists. */
export function host(): HostAdapter {
  return (active ??= claudeAdapter);
}

/** Chooses the host (tests, and later the codex entry). */
export function setHost(next: HostAdapter | null): void {
  active = next;
}
