import { randomUUID } from 'node:crypto';
import { TiloriAgentClient, type McpToolCaller } from '../src/client.ts';
import { normalizeFilter, normalizeScope } from '../src/config.ts';
import type { AgentDelivery, AgentSubscription, DeliveredEvent } from '../src/types.ts';

/** In-memory stand-in for one agent's Tilori event tools. Like the real
 * server, poll_events re-serves the same batch until it is acknowledged. */
export class FakeTilori implements McpToolCaller {
  subs: AgentSubscription[] = [];
  queues = new Map<string, DeliveredEvent[][]>();
  outstanding = new Map<string, AgentDelivery>();
  calls: string[] = [];
  acks: string[] = [];
  failNextPolls = 0;
  failAcks = 0;
  refuse = new Set<string>();

  push(scopeType: string, events: DeliveredEvent[]) {
    const sub = this.subs.find((s) => s.scope.type === scopeType);
    if (!sub) throw new Error(`no ${scopeType} subscription`);
    const q = this.queues.get(sub.id) ?? [];
    q.push(events);
    this.queues.set(sub.id, q);
  }

  async callTool(
    params: { name: string; arguments: Record<string, unknown> },
    _schema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const { name, arguments: a } = params;
    this.calls.push(name);
    const ok = (result: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } });
    const err = (message: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ message }) }] });
    switch (name) {
      case 'list_agent_subscriptions':
        return ok({ subscriptions: this.subs });
      case 'subscribe_to_events': {
        const scope = normalizeScope(a.scope as any);
        if (this.refuse.has(scope.type)) return err(`Missing scope for ${scope.type}`);
        const sub: AgentSubscription = {
          id: randomUUID(),
          scope,
          exclude_self: (a.exclude_self as boolean) ?? true,
          filter: normalizeFilter(a.filter as any),
          cursor: '1',
          expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
        };
        this.subs.push(sub);
        return ok({ subscription: sub });
      }
      case 'poll_events': {
        if (this.failNextPolls > 0) {
          this.failNextPolls--;
          throw new Error('network down Bearer abcdefghijklmnop');
        }
        const id = String(a.subscription_id);
        // Long-poll like the server: wait for a batch or until wait_ms passes.
        const end = Date.now() + Number(a.wait_ms ?? 0);
        while (
          !this.outstanding.get(id) &&
          !this.queues.get(id)?.length &&
          Date.now() < end &&
          !options?.signal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, 5));
        }
        let d = this.outstanding.get(id) ?? null;
        if (!d) {
          const events = this.queues.get(id)?.shift();
          if (events) {
            d = { subscription_id: id, delivery_id: randomUUID(), events, resync_required: false };
            this.outstanding.set(id, d);
          }
        }
        return ok({ delivery: d });
      }
      case 'acknowledge_events': {
        if (this.failAcks > 0) {
          this.failAcks--;
          throw new Error('ack failed');
        }
        const id = String(a.subscription_id);
        if (this.outstanding.get(id)?.delivery_id === a.delivery_id) {
          this.outstanding.delete(id);
          this.acks.push(String(a.delivery_id));
        }
        return ok({});
      }
    }
    return err(`unexpected tool ${name}`);
  }

  client(): TiloriAgentClient {
    return new TiloriAgentClient({ url: new URL('http://127.0.0.1:1/mcp/tilori/v1'), apiKey: 'test-key-123456', mcpClient: this });
  }
}

export function mention(postId: string = randomUUID(), extra: Partial<DeliveredEvent> = {}): DeliveredEvent {
  return {
    id: randomUUID(),
    cursor: '2',
    kind: 'mention',
    entity_type: 'post',
    entity_id: postId,
    parents: {},
    created_at: new Date().toISOString(),
    data: {},
    ...extra,
  };
}

export function dm(conversationId: string = randomUUID()): DeliveredEvent {
  return {
    id: randomUUID(),
    cursor: '3',
    kind: 'dm.message',
    entity_type: 'conversation',
    entity_id: conversationId,
    parents: {},
    created_at: new Date().toISOString(),
    data: { conversation_id: conversationId, message_id: randomUUID() },
  };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
