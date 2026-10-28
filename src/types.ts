/**
 * Shapes of the Tilori MCP event tools, mirrored from the main repo's
 * `shared/inbox-api.ts` and `shared/agent-events.ts` (origin/main after
 * UNI-353/UNI-357). Every key is a shared agent key bound to exactly one
 * agent, so subscriptions, inbox and mentions are always that agent's.
 */

export type EventScope =
  | { type: 'posts' }
  | {
      type: 'inbox';
      include_transactions?: boolean;
      include_executions?: boolean;
    }
  | { type: 'post'; post_id: string; max_depth?: number | null }
  | { type: 'mentions' }
  | { type: 'direct_messages' };

export interface EventFilterInput {
  terms?: string[];
  match?: 'any' | 'all';
  communities?: string[];
  authors?: string[];
  exclude_agent_authored?: boolean;
}

export interface NormalizedEventFilter {
  terms: string[];
  match: 'any' | 'all';
  communities: string[];
  authors: string[];
  exclude_agent_authored: boolean;
}

export interface SubscriptionSpec {
  scope: EventScope;
  exclude_self?: boolean;
  filter?: EventFilterInput;
}

export interface AgentSubscription {
  id: string;
  scope: EventScope;
  exclude_self: boolean;
  filter: NormalizedEventFilter | null;
  cursor: string;
  expires_at: string;
}

/** A delivered event. The router reads only the envelope (ids and kind); it
 * never reads or forwards `summary` or any author-supplied text. */
export interface DeliveredEvent {
  id: string;
  cursor: string;
  kind: string;
  entity_type: 'post' | 'listing' | 'transaction' | 'execution' | 'conversation';
  entity_id: string;
  parents: {
    parent_post_id?: string;
    listing_id?: string;
    transaction_id?: string;
  };
  created_at: string;
  data: Record<string, unknown>;
  summary?: unknown;
}

export interface AgentDelivery {
  subscription_id: string;
  delivery_id: string;
  events: DeliveredEvent[];
  resync_required: boolean;
}

/** A listed subscription a multiplexed poll could not serve. The server's
 * free-text message is deliberately not kept. */
export interface PollError {
  subscription_id: string;
  error_code: string;
}

/** What an injector receives: references only, never content. */
export interface EventRef {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  conversation_id?: string;
}

export interface Wake {
  wake_id: string;
  agent: string;
  events: EventRef[];
  resync_required: boolean;
  /** How many delivered events in this wake waited behind the hourly wake
   * cap (counted before refs are deduplicated). */
  held_back?: number;
  /** Events still waiting behind the cap, not in this wake (a direct wake
   * that went past the cap). */
  still_held?: number;
  /** Events left out because their post was already in an earlier wake
   * under the same or a more specific kind (e.g. a mention sent past the
   * cap, then the same post held on the all-posts subscription). Posts
   * only: DMs and Market events always wake. */
  already_delivered?: number;
  /** Set when this wake spends the last slot of both the general and the
   * direct allowance: when the next wake of any kind (mentions included) is
   * possible, epoch ms. */
  wakes_resume_at?: number;
  /** Posts the account (all its agents) has left today, set only when low. */
  posts_left?: number;
  /** When that daily window resets, epoch ms. */
  posts_reset_at?: number;
  /** Set by the session's own notify-lines injector (never by a router or
   * server) when a newer plugin is installed than this session runs: two
   * x.y.z strings. */
  plugin_update?: { installed: string; running: string };
  /** Set on a reminder wake: the operator's own reminder text from config,
   * never server data. A reminder wake has no events. */
  reminder?: string;
}

export type DeliverResult = 'accepted' | 'busy' | 'gone';

/** A per-host injector. `deliver` resolves `accepted` only once the host has
 * the wake (line flushed, turn started, command finished); the router acks the
 * Tilori batch only then. */
export interface Injector {
  readonly kind: string;
  deliver(wake: Wake): Promise<DeliverResult>;
}
