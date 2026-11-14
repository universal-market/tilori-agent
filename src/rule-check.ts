import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UNI-865 phase 0 (Bastion 56d30062, 47ba6d6e). The plugin marks its Market
 * connection as paired, and the Market server then leaves these tools out of
 * its list, because the Tilori server lists the same tool for the same key.
 * A session then calls the Tilori copy, so a Claude Code `deny` or `ask` rule
 * written for the Market copy (or the whole Market server) silently stops
 * applying. This check only reads the settings files and never edits them.
 */
export const PAIRED_HIDDEN_TOOLS = [
  'list_contract_templates',
  'get_contract_template',
  'list_contracts',
  'get_contract',
  'propose_contract',
  'get_agent',
  'update_agent_profile',
  'list_agents',
  'create_agent',
  'update_agent',
  'claim_agent',
  'list_keys',
  'create_key',
  'rotate_key',
  'revoke_key',
] as const;

const PREFIX = 'mcp__plugin_universal-market_';
const MAX_SETTINGS_BYTES = 1_000_000;

export interface PermissionRules {
  deny: string[];
  ask: string[];
}

/** Whether a rule names this tool on this server: the tool itself, the whole
 * server, or the server's `__*` wildcard. */
export function covers(rule: string, server: 'market' | 'tilori', tool: string): boolean {
  const base = PREFIX + server;
  return rule === base || rule === `${base}__*` || rule === `${base}__${tool}`;
}

/** The settings files Claude Code merges permission rules from: the user's,
 * then the project's shared and local ones. Managed policy files are out of
 * reach of a user's edits and are left out. */
export function settingsFiles(env: NodeJS.ProcessEnv): string[] {
  const files: string[] = [];
  const userDir = env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : '');
  if (userDir.startsWith('/')) files.push(join(userDir, 'settings.json'));
  const project = env.CLAUDE_PROJECT_DIR ?? '';
  if (project.startsWith('/'))
    files.push(join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json'));
  return files;
}

/** The `deny` and `ask` rules across these files. A file that is missing,
 * too large or not JSON is skipped; nothing from it is ever printed. */
export function readRules(files: string[]): PermissionRules {
  const rules: PermissionRules = { deny: [], ask: [] };
  for (const file of files) {
    let parsed: unknown;
    try {
      if (statSync(file).size > MAX_SETTINGS_BYTES) continue;
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const permissions = (parsed as { permissions?: unknown } | null)?.permissions;
    if (!permissions || typeof permissions !== 'object') continue;
    for (const kind of ['deny', 'ask'] as const) {
      const list = (permissions as Record<string, unknown>)[kind];
      if (Array.isArray(list)) for (const rule of list) if (typeof rule === 'string') rules[kind].push(rule.trim());
    }
  }
  return rules;
}

/** The hidden tools a Market `deny` or `ask` rule covers with no rule of the
 * same kind, or a `deny`, covering its Tilori copy. In the fixed order. */
export function uncoveredTools(rules: PermissionRules): string[] {
  return PAIRED_HIDDEN_TOOLS.filter((tool) =>
    (['deny', 'ask'] as const).some(
      (kind) =>
        rules[kind].some((r) => covers(r, 'market', tool)) &&
        !rules[kind].some((r) => covers(r, 'tilori', tool)) &&
        !rules.deny.some((r) => covers(r, 'tilori', tool)),
    ),
  );
}

/** One fixed line, or null. Only tool names from the fixed list appear. */
export function ruleWarning(tools: readonly string[]): string | null {
  if (!tools.length) return null;
  return (
    `Universal Market plugin: a Claude Code deny or ask rule covers the Market copy of ${tools.join(', ')}, ` +
    `but sessions now use the Tilori copy of these tools, which that rule does not cover. ` +
    `To keep the rule, add the same rule for ${PREFIX}tilori__<tool> (or ${PREFIX}tilori__*) in your Claude Code settings. ` +
    `Nothing was changed in your settings.`
  );
}

export function checkRules(env: NodeJS.ProcessEnv): string | null {
  return ruleWarning(uncoveredTools(readRules(settingsFiles(env))));
}
