/**
 * Tilori push via the gateway (design: "Tilori push via gateway"). The
 * agent's key mints a single-use stream ticket from Tilori
 * (`POST <mcp>/stream-ticket`, no MCP session), and the ticket opens a plain
 * SSE stream at the `events_url` Tilori names. Each `events` frame carries
 * ids and kinds only; the router treats it as "poll this agent now" and reads
 * the batch with a zero-wait poll_events, so caps, holds, wake lines and
 * acknowledgements stay on the one path they already use.
 *
 * The key goes only to Tilori's own MCP endpoint, never to the gateway: the
 * gateway gets the ticket, in its header, and nothing else. There is no
 * long-poll fallback while push is down (Don): the stream is retried with
 * jittered backoff from 5 s to 5 min, and each reconnect is followed by one
 * zero-wait sweep.
 */

/** The header a ticket travels in; never Authorization, never the URL. */
export const TICKET_HEADER = 'tilori-stream-ticket';
const TICKET = /^tst_[A-Za-z0-9_-]{43}$/;
/** First retry delay and the cap (Don: 5 s up to 5 min). */
export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;
/** Not live for this long is "down" (one monitor line); shorter gaps, such
 * as the gateway's planned 25-30 min reopen, never show. */
export const DOWN_AFTER_MS = 60_000;
/** A stream that lived this long and then ended was a planned reopen:
 * reconnect at once, without counting a failure. */
export const PLANNED_MS = 20 * 60_000;
/** Refused (key or access): retry slowly, in case access is restored. */
export const REFUSED_RETRY_MS = 5 * 60_000;
/** A planned reopen waits at least this long, plus up to PLANNED_JITTER_MS,
 * so a gateway that says `retry: 0` can't make every agent mint at once. */
export const PLANNED_MIN_MS = 1_000;
export const PLANNED_JITTER_MS = 2_000;
/** A stream that ends sooner than this is a failure, whatever it said, so a
 * gateway that opens and closes at once backs off instead of looping. */
export const MIN_LIVED_MS = 30_000;
/** One SSE event larger than this ends the stream (frames are ids only). */
const MAX_EVENT_BYTES = 256 * 1024;

export type PushState = 'connecting' | 'live' | 'reconnecting' | 'down' | 'refused';

export interface PushStatus {
  state: PushState;
  /** When this state began (epoch ms); for `down`, when push was lost. */
  since: number;
  /** When the next attempt is due (reconnecting, down, refused). */
  next?: number;
}

export interface PushHooks {
  /** A frame named this subscription: poll it now. */
  frame(subscriptionId: string): void;
  /** The stream is open: sweep every subscription once. `back` is set when
   * it was down (a "back" line follows the sweep). */
  connected(back: boolean): void;
  /** Push has been out long enough to say so (once per outage). */
  down(since: number): void;
  /** The heartbeat or a frame arrived: the stream is still watched. */
  alive(): void;
  status(s: PushStatus): void;
  log(message: string): void;
}

export interface PushOptions {
  /** The agent's Tilori MCP endpoint (the key's URL). */
  endpoint: URL;
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Why an attempt ended, which decides the next delay. */
type Ended =
  | { kind: 'planned'; retryMs?: number }
  | { kind: 'failed'; retryMs?: number; why: string }
  | { kind: 'refused'; why: string };

class Refused extends Error {}
class Failed extends Error {
  constructor(
    message: string,
    readonly retryMs?: number,
  ) {
    super(message);
  }
}

const retryAfter = (res: Response): number | undefined => {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, RETRY_MAX_MS) : undefined;
};

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** The events URL Tilori named, if it is one the ticket may be sent to:
 * https, or http only when the MCP endpoint itself is loopback http (tests,
 * local development). No credentials or fragment in it. */
export function eventsUrl(raw: unknown, endpoint: URL): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const loopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && endpoint.protocol === 'http:' && loopback(endpoint) && loopback(url)) return url;
  return null;
}

/**
 * One agent's push stream, kept open until `signal` aborts. Never throws;
 * every outcome is a state, a log line or a hook call.
 */
export class PushStream {
  readonly #o: Required<Omit<PushOptions, 'fetch'>> & { fetch: typeof fetch };
  #status: PushStatus;
  /** When push was last lost (0 while live or before the first open). */
  #lostAt = 0;
  #saidDown = false;
  #failures = 0;

  constructor(
    options: PushOptions,
    private readonly hooks: PushHooks,
  ) {
    this.#o = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      fetch: options.fetch ?? fetch,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
    };
    this.#status = { state: 'connecting', since: this.#o.now() };
  }

  get status(): PushStatus {
    return this.#status;
  }

  #set(state: PushState, next?: number) {
    const now = this.#o.now();
    const since = state === 'down' ? this.#lostAt : state === this.#status.state ? this.#status.since : now;
    this.#status = { state, since, ...(next !== undefined ? { next } : {}) };
    this.hooks.status(this.#status);
  }

  /** 5 s doubling to 5 min, each between 80% and 120%. */
  #backoff(): number {
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, this.#failures - 1));
    return Math.min(RETRY_MAX_MS, Math.round(base * (0.8 + 0.4 * this.#o.random())));
  }

  async run(signal: AbortSignal): Promise<void> {
    this.hooks.status(this.#status);
    while (!signal.aborted) {
      const ended = await this.#attempt(signal);
      if (signal.aborted) return;
      const now = this.#o.now();
      let wait: number;
      if (ended.kind === 'planned') {
        // The gateway's planned reopen (or a drain): back soon, no line. The
        // floor and jitter spread every agent's mint over a few seconds.
        wait =
          Math.max(PLANNED_MIN_MS, Math.min(ended.retryMs ?? 0, 10_000)) +
          Math.round(PLANNED_JITTER_MS * this.#o.random());
      } else {
        if (!this.#lostAt) this.#lostAt = now;
        if (ended.kind === 'refused') {
          this.#failures = 0;
          wait = REFUSED_RETRY_MS;
          this.hooks.log(`push refused: ${ended.why}; retrying in ${Math.round(wait / 60_000)} min`);
        } else {
          this.#failures++;
          wait = Math.max(this.#backoff(), ended.retryMs ?? 0);
          this.hooks.log(`push unavailable (${ended.why}); retrying in ${Math.round(wait / 1000)} s`);
        }
        const lostFor = now - this.#lostAt;
        if (ended.kind === 'refused') this.#set('refused', now + wait);
        else if (lostFor >= DOWN_AFTER_MS || this.#saidDown) this.#set('down', now + wait);
        else this.#set('reconnecting', now + wait);
        this.#maybeDown(now);
        // Re-check for "down" while waiting a long time.
        if (!this.#saidDown && ended.kind !== 'refused' && lostFor + wait > DOWN_AFTER_MS) {
          const untilDown = Math.max(0, DOWN_AFTER_MS - lostFor);
          await this.#o.sleep(untilDown, signal);
          if (signal.aborted) return;
          this.#set('down', now + wait);
          this.#maybeDown(this.#o.now());
          wait -= untilDown;
        }
      }
      if (wait > 0) await this.#o.sleep(wait, signal);
    }
  }

  #maybeDown(now: number) {
    if (this.#saidDown || !this.#lostAt || now - this.#lostAt < DOWN_AFTER_MS) return;
    if (this.#status.state === 'refused') return;
    this.#saidDown = true;
    this.hooks.down(this.#lostAt);
  }

  /** Mints a ticket, opens the stream and reads it until it ends. */
  async #attempt(signal: AbortSignal): Promise<Ended> {
    let res: Response;
    try {
      const { ticket, url } = await this.#mint(signal);
      res = await this.#o.fetch(url, {
        headers: { accept: 'text/event-stream', [TICKET_HEADER]: ticket },
        redirect: 'error',
        signal,
      });
    } catch (cause) {
      if (cause instanceof Refused) return { kind: 'refused', why: cause.message };
      if (cause instanceof Failed) return { kind: 'failed', why: cause.message, retryMs: cause.retryMs };
      return { kind: 'failed', why: signal.aborted ? 'stopped' : 'network error' };
    }
    if (res.status === 403) {
      const code = await res
        .json()
        .then((b: any) => (typeof b?.code === 'string' ? b.code : ''))
        .catch(() => '');
      await res.body?.cancel().catch(() => {});
      // An expired or used ticket just needs a new one; a refused one means
      // the key or its access.
      return code === 'TICKET_REFUSED'
        ? { kind: 'refused', why: 'the gateway refused the key’s ticket' }
        : { kind: 'failed', why: `gateway 403 ${code || 'refused'}` };
    }
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'failed', why: `gateway ${res.status}`, retryMs: retryAfter(res) };
    }
    const opened = this.#o.now();
    const back = this.#saidDown;
    // #failures is cleared only once the stream has lived MIN_LIVED_MS, so
    // streams that open and end at once keep backing off.
    this.#lostAt = 0;
    this.#saidDown = false;
    this.#set('live');
    this.hooks.connected(back);
    this.hooks.alive();
    let retryMs: number | undefined;
    let broke = false;
    try {
      retryMs = await this.#read(res, signal);
    } catch {
      broke = true;
    }
    if (signal.aborted) return { kind: 'planned' };
    const lived = this.#o.now() - opened;
    if (lived >= MIN_LIVED_MS) this.#failures = 0;
    if (broke) return { kind: 'failed', why: 'stream broke' };
    if (lived < MIN_LIVED_MS) return { kind: 'failed', why: `stream ended after ${Math.round(lived / 1000)} s`, retryMs };
    // A drain sends a short retry hint; a stream that lived its lifetime
    // closes on its own. Both reconnect at once, with no state change.
    if (lived >= PLANNED_MS || (retryMs !== undefined && retryMs <= 10_000))
      return { kind: 'planned', retryMs };
    return { kind: 'failed', why: 'stream closed early' };
  }

  async #mint(signal: AbortSignal): Promise<{ ticket: string; url: URL }> {
    const at = new URL(this.#o.endpoint.pathname.replace(/\/+$/, '') + '/stream-ticket', this.#o.endpoint);
    let res: Response;
    try {
      res = await this.#o.fetch(at, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#o.apiKey}`, accept: 'application/json' },
        // A redirect must not carry the key anywhere else.
        redirect: 'error',
        signal,
      });
    } catch {
      throw new Failed('Tilori unreachable');
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new Refused(`Tilori ${res.status} on stream-ticket`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Failed(`Tilori ${res.status} on stream-ticket`, retryAfter(res));
    }
    const body: any = await res.json().catch(() => null);
    const url = eventsUrl(body?.events_url, this.#o.endpoint);
    if (typeof body?.ticket !== 'string' || !TICKET.test(body.ticket) || !url)
      throw new Failed('Tilori gave no usable push ticket');
    return { ticket: body.ticket, url };
  }

  /** Reads SSE until the stream ends; returns the last `retry:` hint. */
  async #read(res: Response, signal: AbortSignal): Promise<number | undefined> {
    if (!res.body) return undefined;
    const reader = res.body.getReader();
    const stop = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', stop, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data = '';
    let retryMs: number | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return retryMs;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_EVENT_BYTES) throw new Error('event too large');
        let nl: number;
        while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
          if (line === '') {
            if (event === 'events' && data) this.#frame(data);
            event = '';
            data = '';
            continue;
          }
          if (line.startsWith(':')) {
            this.hooks.alive();
            continue;
          }
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') {
            data = data ? `${data}\n${value}` : value;
            if (data.length > MAX_EVENT_BYTES) throw new Error('event too large');
          } else if (field === 'retry' && /^\d{1,7}$/.test(value)) retryMs = Number(value);
        }
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  /** A frame's only use is its subscription id; everything else is ignored. */
  #frame(data: string) {
    let id: unknown;
    try {
      id = JSON.parse(data)?.subscriptionId;
    } catch {
      return;
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    this.hooks.alive();
    this.hooks.frame(id);
  }
}
