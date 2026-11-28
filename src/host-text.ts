// Host-named text (UNI-1178 S1a). Everything user-facing that names the host
// (Claude Code today, Codex later) comes from one table per host, through the
// single accessor below. Core code never spells a restart line, a slash
// command (/mcp, /tilori:..., /universal-market:...) or a tool name prefix
// itself. tests/host-text-grep.test.ts enforces that.
import { claudeText } from './hosts/claude/text.ts';

/**
 * The host's words. Every key is required in every table, so a missing key
 * fails the typecheck. Strings with variable parts are functions with typed
 * parameters. Values are the exact output (no trailing newline unless said).
 */
export interface HostText {
  /** Prefix of the host's names for the plugin's MCP tools; the tool name follows. */
  toolPrefix: string;

  // --- Session start note (config.ts) ---
  /** Fix for a plugin option that names another deployment, in another home. */
  optionFixOtherHome: (home: string, agent: string) => string;
  /** Same, in the default home: the command that syncs the options. */
  optionFixSync: (configPath: string) => string;
  /** The trust_server=on line of the session note. */
  trustServerOnLine: string;
  /** The session note's fallback when Tilori or Market tools are missing. */
  toolsMissingLine: string;

  // --- Wake notes (wake.ts, activity.ts) ---
  /** Appended to the "newer plugin installed" wake note (no leading space). */
  pluginUpdateAdvice: string;
  /** The "Tilori's tools changed" wake note (no leading space). */
  toolsChangedNote: string;
  /** status: nothing is pushed to this agent, and how to start a watcher. */
  startItAdvice: string;

  // --- Setup (setup.ts) ---
  setupReuse: (handle: string) => string;
  setupLive: (owner: string, handle: string) => string;
  setupConnected: (handle: string) => string;
  setupDecisionCheck: string;
  setupTimeout: string;
  setupExpired: (handle: string) => string;
  setupKeyExists: (handle: string) => string;
  setupUnusable: (handle: string, why: string) => string;

  // --- Key refresh (refresh.ts) ---
  refreshNoKey: (handle: string) => string;
  refreshKept: (handle: string) => string;
  refreshTimeout: (handle: string) => string;
  refreshExpired: (handle: string) => string;
  /** `code` is the already-formatted suffix after "HTTP 401" (may be empty). */
  refreshRefused401: (handle: string, code: string) => string;
  refreshNoServer: string;

  // --- Plugin sync (plugin-sync.ts) ---
  syncOtherHome: (home: string, launcher: string) => string;
  syncUnread: string;
  /** `escapedValues` is the values JSON with single quotes shell-escaped. */
  syncByHand: (escapedValues: string, pluginId: string) => string;
  syncRestart: string;
  noLauncherBinary: string;

  // --- Connect (connect.ts) ---
  connectNoKey: string;
  connectNoMarket: string;
  connectRestart: string[];
  /** `quotedValues` is the values JSON as one shell word. */
  connectByHand: (quotedValues: string, pluginId: string) => string;

  // --- Rule check (rule-check.ts) ---
  ruleWarning: (tools: string, prefix: string) => string;

  // --- Launcher and headers errors (cli.ts) ---
  launchFlagsError: string;
  launchSettingsError: string;
  launchStartFailed: (reason: string) => string;
  headersNeedsUrl: string;

  // --- Usage text fragments (cli.ts) ---
  /** The host as the usage text names it for plain sessions: "plain `claude`". */
  usagePlainHost: string;
  usageRestartAfter: string;
  /** The whole entry for the launcher command, from its name to its last line. */
  usageLaunchEntry: string;
  usageWatchNotify: string;
  usagePolicyHook: string;
  usageStopHook: string;
  usageServerUrlEnv: string;
  usageOwnerConfig: string;
}

/** The active table. Always Claude's until a second host exists. */
export function hostText(): HostText {
  return claudeText;
}
