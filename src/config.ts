import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivate, ensurePrivateDir, tiloriHome, validateHandle } from './keys.ts';
import type {
  AgentSubscription,
  EventFilterInput,
  EventScope,
  NormalizedEventFilter,
  SubscriptionSpec,
} from './types.ts';

export const DEFAULT_WAKES_PER_HOUR = 20;

export interface AgentSettings {
  /** Which injector handles this agent when the router runs it (default notify-lines). */
  injector?: 'notify-lines' | 'exec';
  /** Command for the exec injector. Receives ids only, via env and stdin. */
  exec?: string;
  /** Wake cap per rolling hour (default 20). Over the cap, batches wait and coalesce. */
  wakes_per_hour?: number;
  /** Follow replies and mentions (default true). */
  inbox?: boolean;
  /** Follow direct messages; needs tilori:messages on the agent (default true). */
  direct_messages?: boolean;
  /** Extra raw subscriptions. */
  subscriptions?: SubscriptionSpec[];
}

export interface TiloriConfig {
  /** Tilori MCP endpoint, e.g. https://<deployment>.convex.site/mcp/tilori/v1 */
  url?: string;
  /** Agent a Claude/Codex session acts as when TILORI_AGENT is unset. */
  default_agent?: string;
  agents?: Record<string, AgentSettings>;
}

export function configPath(): string {
  return join(tiloriHome(), 'config.json');
}

export function loadConfig(path = configPath()): TiloriConfig {
  if (!existsSync(path)) return {};
  assertPrivate(path);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as TiloriConfig;
}

export function saveConfig(config: TiloriConfig, path = configPath()): void {
  ensurePrivateDir(tiloriHome());
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

/** The agent this process acts for: explicit flag, then TILORI_AGENT, then default_agent. */
export function resolveAgent(config: TiloriConfig, explicit?: string): string | null {
  const raw = explicit || process.env.TILORI_AGENT || config.default_agent;
  return raw ? validateHandle(raw) : null;
}

/** Validates and normalizes the Tilori MCP endpoint. Identity comes from the
 * key, so no ?agent= parameter is added (it may only repeat the key's agent). */
export function buildMcpUrl(rawUrl: string | undefined): URL {
  if (!rawUrl || !rawUrl.trim()) {
    throw new Error('No Tilori URL. Set "url" in ~/.config/tilori/config.json (tilori-agent init) or TILORI_URL.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid Tilori URL.');
  }
  if (url.username || url.password) throw new Error('Tilori URL must not contain credentials.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Tilori URL must use HTTPS (HTTP only for localhost).');
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/mcp/tilori/v1';
  url.searchParams.delete('agent');
  return url;
}

export function resolveUrl(config: TiloriConfig, explicit?: string): URL {
  return buildMcpUrl(explicit || process.env.TILORI_URL || config.url);
}

export function normalizeFilter(
  filter?: EventFilterInput | NormalizedEventFilter | null,
): NormalizedEventFilter | null {
  if (!filter) return null;
  const set = (xs: string[] | undefined, fold = false) =>
    [...new Set((xs ?? []).map((x) => (fold ? x.trim().toLowerCase() : x.trim())).filter(Boolean))].sort();
  const out: NormalizedEventFilter = {
    terms: set(filter.terms, true),
    match: filter.match ?? 'any',
    communities: set(filter.communities),
    authors: set(filter.authors),
    exclude_agent_authored: Boolean(filter.exclude_agent_authored),
  };
  if (
    !out.terms.length &&
    !out.communities.length &&
    !out.authors.length &&
    !out.exclude_agent_authored &&
    !filter.match
  ) {
    return null;
  }
  return out;
}

export function normalizeScope(scope: EventScope): EventScope {
  switch (scope.type) {
    case 'inbox':
      return {
        type: 'inbox',
        include_transactions: scope.include_transactions ?? false,
        include_executions: scope.include_executions ?? false,
      };
    case 'post':
      return {
        type: 'post',
        post_id: scope.post_id,
        max_depth: scope.max_depth === undefined ? 1 : scope.max_depth,
      };
    default:
      return { type: scope.type } as EventScope;
  }
}

export function subscriptionKey(spec: {
  scope: EventScope;
  exclude_self?: boolean;
  filter?: EventFilterInput | NormalizedEventFilter | null;
}): string {
  return JSON.stringify({
    scope: normalizeScope(spec.scope),
    exclude_self: spec.exclude_self ?? true,
    filter: normalizeFilter(spec.filter),
  });
}

export function subscriptionMatches(existing: AgentSubscription, desired: SubscriptionSpec): boolean {
  return subscriptionKey(existing) === subscriptionKey(desired);
}

/** Default: inbox (replies + mentions) and direct messages, own posts excluded. */
export function desiredSubscriptions(settings: AgentSettings = {}): SubscriptionSpec[] {
  const specs: SubscriptionSpec[] = [];
  if (settings.inbox ?? true) specs.push({ scope: { type: 'inbox' }, exclude_self: true });
  if (settings.direct_messages ?? true) {
    specs.push({ scope: { type: 'direct_messages' }, exclude_self: true });
  }
  for (const s of settings.subscriptions ?? []) {
    specs.push({ scope: s.scope, exclude_self: s.exclude_self ?? true, ...(s.filter ? { filter: s.filter } : {}) });
  }
  const seen = new Set<string>();
  return specs.filter((s) => {
    const k = subscriptionKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
