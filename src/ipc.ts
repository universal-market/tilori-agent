import { existsSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPrivate, ensurePrivateDir, isOtherHome, tiloriHome, validateHandle } from './keys.ts';
import type { AgentUsage, Router } from './router.ts';
import type { DeliverResult, Injector, Wake } from './types.ts';
import { sanitizeWake } from './wake.ts';

/**
 * Local IPC between the router and per-host injectors (newline-delimited
 * JSON over a Unix socket).
 *
 *   injector → router  {"op":"register","v":1,"agent":"wren","injector":"notify-lines"}
 *   router → injector  {"op":"registered","agent":"wren"} | {"op":"error","message":"…"}
 *   router → injector  {"op":"wake","wake_id":"…","agent":"wren","events":[{id,kind,entity_type,entity_id}],"resync_required":false}
 *   router → injector  {"op":"wake","wake_id":"…","agent":"wren","events":[],"resync_required":false,"reminder":"…"}
 *   injector → router  {"op":"accepted"|"busy","wake_id":"…"}
 *
 * Or, as the first and only message, a usage query for `config show`:
 *
 *   client → router    {"op":"usage","v":1,"agent":"wren"}
 *   router → client    {"op":"usage","agent":"wren","wakes":{used,limit},"direct":{used,limit}|null,"held":0}
 *
 * The answer is counts only, and the router closes the connection after it.
 *
 * No key or event content ever crosses the socket: wakes carry ids only. A
 * reminder wake carries the router's own configured text instead, which the
 * injector side validates again.
 *
 * Access control: the socket lives in a 0700 directory owned by this user and
 * is itself 0600, so the kernel refuses connections from other users (Node
 * cannot read SO_PEERCRED). Clients check the directory and socket owner
 * before connecting, so they never attach to another user's socket.
 */

export const IPC_VERSION = 1;
const MAX_LINE = 64 * 1024;

export function socketPath(): string {
  if (process.env.TILORI_SOCKET) return process.env.TILORI_SOCKET;
  // A second home gets its own router and run files under that home, so a
  // watcher for one instance never shares a socket (or wakes) with another's
  // (UNI-751). The default home keeps the runtime-dir path.
  if (isOtherHome()) return join(tiloriHome(), 'run', 'router.sock');
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, 'tilori', 'router.sock') : join(tiloriHome(), 'run', 'router.sock');
}

function assertOwnedSocket(path: string): void {
  assertPrivate(dirname(path), true);
  const st = lstatSync(path);
  if (!st.isSocket()) throw new Error(`${path} is not a socket.`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${path} is owned by another user.`);
  }
}

function lines(sock: Socket, onLine: (msg: any) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) {
      sock.destroy();
      return;
    }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        sock.destroy();
        return;
      }
    }
  });
}

const send = (sock: Socket, msg: unknown) => {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
};

/** Router side: an injector that lives in another process. */
class RemoteInjector implements Injector {
  readonly #waiting = new Map<string, (r: DeliverResult) => void>();
  #closed = false;

  constructor(
    readonly kind: string,
    private readonly sock: Socket,
  ) {
    sock.on('close', () => {
      this.#closed = true;
      for (const resolve of this.#waiting.values()) resolve('gone');
      this.#waiting.clear();
    });
  }

  reply(msg: any) {
    const resolve = this.#waiting.get(msg?.wake_id);
    if (!resolve) return;
    this.#waiting.delete(msg.wake_id);
    resolve(msg.op === 'accepted' ? 'accepted' : 'busy');
  }

  deliver(wake: Wake): Promise<DeliverResult> {
    if (this.#closed) return Promise.resolve('gone');
    return new Promise((resolve) => {
      this.#waiting.set(wake.wake_id, resolve);
      send(this.sock, { op: 'wake', ...wake });
    });
  }
}

export async function serveRouter(router: Router, path = socketPath(), log: (m: string) => void = () => {}): Promise<Server> {
  ensurePrivateDir(dirname(path));
  if (existsSync(path)) {
    assertOwnedSocket(path);
    const live = await new Promise<boolean>((resolve) => {
      const c = createConnection(path);
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => resolve(false));
    });
    if (live) throw new Error(`A tilori-agent router is already listening on ${path}.`);
    unlinkSync(path);
  }
  const conns = new Set<Socket>();
  const server = createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    let injector: RemoteInjector | null = null;
    let unregister: (() => void) | null = null;
    sock.on('close', () => unregister?.());
    sock.on('error', () => {});
    lines(sock, (msg) => {
      if (!injector && msg?.op === 'usage') {
        try {
          if (msg.v !== IPC_VERSION) throw new Error('Expected a v1 usage message.');
          const agent = validateHandle(String(msg.agent ?? ''));
          const usage = router.usage(agent);
          if (!usage) throw new Error(`This router does not serve agent ${agent}.`);
          send(sock, { op: 'usage', agent, ...usage });
        } catch (cause) {
          send(sock, { op: 'error', message: cause instanceof Error ? cause.message : 'usage failed' });
        }
        sock.end();
        return;
      }
      if (!injector) {
        try {
          if (msg?.op !== 'register' || msg.v !== IPC_VERSION) throw new Error('Expected a v1 register message.');
          const agent = validateHandle(String(msg.agent ?? ''));
          const kind = msg.injector === 'notify-lines' ? 'notify-lines' : 'remote';
          injector = new RemoteInjector(kind, sock);
          unregister = router.register(agent, injector);
          send(sock, { op: 'registered', agent });
          log(`[${agent}] ${kind} injector attached`);
        } catch (cause) {
          send(sock, { op: 'error', message: cause instanceof Error ? cause.message : 'register failed' });
          sock.end();
        }
        return;
      }
      if (msg?.op === 'accepted' || msg?.op === 'busy') injector.reply(msg);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  // Closing the router also drops attached injectors, so they can reconnect
  // to a new router or fall back to polling directly.
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const c of conns) c.destroy();
    return close(cb);
  }) as typeof server.close;
  return server;
}

/** Identity of the socket file (inode + mtime), or null if absent or not ours. */
export function socketIdentity(path = socketPath()): string | null {
  try {
    assertOwnedSocket(path);
    const st = lstatSync(path);
    return `${st.ino}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Whether a live router owned by this user is listening (connect test). */
export async function probeRouter(path = socketPath()): Promise<boolean> {
  if (!routerAvailable(path)) return false;
  return new Promise<boolean>((resolve) => {
    const c = createConnection(path);
    const t = setTimeout(() => {
      c.destroy();
      resolve(false);
    }, 2_000);
    c.once('connect', () => {
      clearTimeout(t);
      c.destroy();
      resolve(true);
    });
    c.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** Whether a router socket owned by this user exists (it may still be stale). */
export function routerAvailable(path = socketPath()): boolean {
  try {
    if (!existsSync(path)) return false;
    assertOwnedSocket(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injector side: attaches a local injector to the router for one agent and
 * forwards wakes to it. Resolves when the connection closes; rejects if the
 * router refuses the registration or cannot be reached.
 */
export function attachToRouter(
  agent: string,
  injector: Injector,
  path = socketPath(),
  onRegistered: () => void = () => {},
): Promise<void> {
  assertOwnedSocket(path);
  const handle = validateHandle(agent);
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let registered = false;
    sock.on('error', (err) => (registered ? resolve() : reject(err)));
    sock.on('close', () => (registered ? resolve() : reject(new Error('Router closed the connection.'))));
    sock.on('connect', () =>
      send(sock, { op: 'register', v: IPC_VERSION, agent: handle, injector: injector.kind, client: randomUUID() }),
    );
    lines(sock, async (msg) => {
      if (msg?.op === 'registered') {
        registered = true;
        onRegistered();
      } else if (msg?.op === 'error') {
        reject(new Error(`Router refused: ${String(msg.message).slice(0, 200)}`));
        sock.end();
      } else if (msg?.op === 'wake' && registered) {
        const wake = sanitizeWake(msg, handle);
        if (!wake) return;
        const result = await injector.deliver(wake);
        send(sock, { op: result === 'accepted' ? 'accepted' : 'busy', wake_id: wake.wake_id });
        if (result === 'gone') sock.end();
      }
    });
  });
}

const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** Asks the running router for one agent's usage this hour. Null when no
 * router of this user is listening, it doesn't serve the agent, or it doesn't
 * answer within 2 s (an older router ignores the query). */
export function routerUsage(agent: string, path = socketPath()): Promise<AgentUsage | null> {
  if (!routerAvailable(path)) return Promise.resolve(null);
  const handle = validateHandle(agent);
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const done = (u: AgentUsage | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(u);
    };
    const timer = setTimeout(() => done(null), 2_000);
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
    sock.on('connect', () => send(sock, { op: 'usage', v: IPC_VERSION, agent: handle }));
    lines(sock, (msg) => {
      if (msg?.op !== 'usage' || msg.agent !== handle) return done(null);
      const pair = (p: any) => {
        const used = count(p?.used);
        const limit = count(p?.limit);
        return used === null || limit === null ? null : { used, limit };
      };
      const wakes = pair(msg.wakes);
      const direct = msg.direct === null ? null : pair(msg.direct);
      const held = count(msg.held);
      if (!wakes || held === null || (msg.direct !== null && !direct)) return done(null);
      done({ wakes, direct, held });
    });
  });
}
