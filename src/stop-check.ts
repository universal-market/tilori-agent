import { closeSync, constants, futimesSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { HANDLE_RE } from './keys.ts';

/**
 * The end-of-turn owner-decision check (UNI-956, design ad78d60f; Don's calls
 * 25916579). A host plugin's Stop hook runs `tilori-agent stop-check --hook`
 * with the hook's JSON on stdin. When the session's last message asks its
 * owner for a decision and no owner request was filed this turn, it prints
 * one `{"decision":"block","reason":…}` so the agent files it with ask_owner
 * or says why not. Otherwise it prints nothing.
 *
 * Off unless the agent's `owner_decision_check` is on. It fails open: any
 * error, missing file or unexpected input prints nothing and exits 0, so a
 * broken check never holds a session.
 *
 * Files, all in the router's own 0700 run directory (activity.ts), opened
 * without following symlinks and read only when they are this user's regular
 * files:
 *
 *   caps-<agent>       written by the router from get_my_profile: whether
 *                      the agent lists ask_owner. Missing means no block.
 *   asked-<agent>      touched by the host's PostToolUse hook after a
 *                      successful ask_owner. Newer than the last check means
 *                      a request was filed this turn.
 *   stopcheck-<agent>  touched by every check that gets as far as the
 *                      message, so `asked-` is compared with the last check.
 *   stopblock-<agent>  touched on each block: at most one per 30 minutes.
 *
 * Nothing from the message is echoed: the reason is fixed text.
 */

/** Juniper 10c3a143 and bad34148. No config key: the check is opt-in, so whoever sees it
 * turned it on. */
export const BLOCK_REASON =
  'Your last message asks your owner for a decision, but no owner request was filed this turn. ' +
  'If only your owner can decide it, check list_owner_requests and file it with ask_owner (cite the request id in your message). ' +
  'If it is already filed, or your user is here and can answer now, or it was not a decision, say so in one line and stop.';

/** At most one block per agent in this window (design: 30 min cut repeats
 * of a pending ask from about 30 to 6 a day). */
export const STOP_BLOCK_COOLDOWN_MS = 30 * 60_000;
/** Only the end of the message is matched (Bastion 785bd425). */
export const MATCH_TAIL_BYTES = 4096;
const MAX_STDIN_BYTES = 1 << 20;
const MAX_CAPS_BYTES = 64;

/** Code, inline code and quotes are not the agent asking anything. */
function strip(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^>.*$/gm, ' ');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Second person only: the hook can't know the owner's name, and third-person
 * status lines ("still Don's call") were mostly not asks (replay, design §0). */
const ASKS: readonly RegExp[] = [
  // A labelled ask: "Decision for you:", "Your call:", "Needs your OK:".
  /^\W*(?:\*\*)?(?:your (?:calls?|decisions?)|decisions? for you|needs? your (?:decision|answer|ok|okay|approval)|questions? for you)\b[^.]{0,20}:/i,
  /\b(?:(?:is|are|it'?s|stays?|still|be) your (?:call|decision)s?\b|needs? your (?:decision|approval|ok|okay|answer|answers|go-ahead|sign-?off|yes|call)|(?:waiting|blocked) (?:on|for) (?:you\b|your (?:decision|answer|approval|ok|okay|yes|go-ahead))|say (?:go|yes|if you want)|once you (?:decide|confirm|approve|answer|say))/i,
  /\b(?:please (?:confirm|decide|approve|choose|pick|advise)|let me know (?:which|whether|if you(?:'d| would)? (?:like|want|prefer)|how you(?:'d| would)? like))\b/i,
  /\b(?:do you want|would you (?:like|prefer|rather)|should (?:I|we)|shall I|want me to|which (?:option|one|do you)|ok(?:ay)? to (?:proceed|merge|ship|push|go|delete|remove)|may I|can I (?:go ahead|proceed|merge)|do you (?:approve|prefer|agree))\b[^?]{0,200}\?/i,
];
/** Says nothing is asked now, or reports an answer already given. */
const NOT_ASKING =
  /\b(?:nothing (?:new |else )?(?:needs|is waiting on|waits on|is blocked on) you|(?:doesn'?t|does not|don'?t|no longer|not) (?:need|needs|wait|waiting|blocked)[^.]{0,30}\byou|no decision (?:is )?needed|until your decision|passed your decision|your decision (?:was|is in|came)|you (?:said|decided|approved|answered|confirmed))\b/i;
/** The sentence points at a request already filed (layer 1's convention). */
const FILED = /\b(?:ask_owner|owner request|inbox|filed|request (?:is )?open)\b/i;

/** Whether `message` asks its reader for a decision, judged on its last 4 KB.
 * A sentence that cites a filed request, or says nothing is needed, never
 * counts. A message whose last sentence is a question counts too (the four
 * plain questions the patterns missed in the replay). */
export function asksOwner(message: string): boolean {
  const tail = Buffer.from(message, 'utf8').subarray(-MATCH_TAIL_BYTES).toString('utf8');
  const all = sentences(strip(tail));
  const open = (s: string) => !NOT_ASKING.test(s) && !FILED.test(s);
  if (all.some((s) => open(s) && ASKS.some((r) => r.test(s)))) return true;
  const last = all.at(-1);
  return last !== undefined && last.endsWith('?') && open(last);
}

export interface StopHookInput {
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  transcript_path?: unknown;
}

export interface StopCheckEnv {
  /** `owner_decision_check` for this agent. */
  enabled: boolean;
  handle: string;
  /** The router's run directory. */
  dir: string;
  now: number;
}

/** A file's mtime (ms), or null unless it is this user's regular file. */
function mtime(path: string): number | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/** Sets a marker's mtime to `at`, created 0600, never through a symlink. */
function touch(path: string, at: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const t = new Date(at);
    futimesSync(fd, t, t);
  } finally {
    closeSync(fd);
  }
}

/** Reads at most `max` bytes of this user's regular file, without following
 * a symlink; null otherwise. With `tail`, the last `max` bytes. */
function readOwnFile(path: string, max: number, tail = false): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if (!tail && st.size > max) return null;
    const start = tail ? Math.max(0, st.size - max) : 0;
    const buf = Buffer.alloc(Math.min(max, st.size));
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** `caps-<agent>`: exactly `{"ask_owner":true}` or `{"ask_owner":false}`.
 * Anything else, or no file, reads as false. */
export function readCanAsk(dir: string, handle: string): boolean {
  if (!HANDLE_RE.test(handle)) return false;
  const raw = readOwnFile(join(dir, `caps-${handle}`), MAX_CAPS_BYTES);
  if (raw === null) return false;
  try {
    const v = JSON.parse(raw);
    return (
      v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && v.ask_owner === true
    );
  } catch {
    return false;
  }
}

/** The last assistant text in a Claude Code transcript's final 64 KB, for a
 * host that doesn't send `last_assistant_message`. Null when there is none. */
export function lastAssistantText(transcriptPath: string): string | null {
  const raw = readOwnFile(transcriptPath, 64 * 1024, true);
  if (raw === null) return null;
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: any;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row?.type !== 'assistant' || !Array.isArray(row?.message?.content)) continue;
    const text = row.message.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
    if (text) return text;
  }
  return null;
}

/** The decision for one Stop hook call: the block JSON, or null for none.
 * Touches `stopcheck-` once the message is reached, and `stopblock-` on a
 * block. Throws only on a marker write; the caller treats that as no block. */
export function stopCheck(input: StopHookInput, env: StopCheckEnv): string | null {
  if (!env.enabled || input.stop_hook_active === true) return null;
  if (!HANDLE_RE.test(env.handle)) return null;
  if (!readCanAsk(env.dir, env.handle)) return null;
  const at = (name: string) => join(env.dir, `${name}-${env.handle}`);
  const lastCheck = mtime(at('stopcheck'));
  const asked = mtime(at('asked'));
  touch(at('stopcheck'), env.now);
  // Filed this turn: asked since the previous check (or ever, on the first).
  if (asked !== null && (lastCheck === null || asked >= lastCheck)) return null;
  const blocked = mtime(at('stopblock'));
  if (blocked !== null && env.now - blocked < STOP_BLOCK_COOLDOWN_MS) return null;
  const message =
    typeof input.last_assistant_message === 'string'
      ? input.last_assistant_message
      : typeof input.transcript_path === 'string'
        ? lastAssistantText(input.transcript_path)
        : null;
  if (!message || !asksOwner(message)) return null;
  touch(at('stopblock'), env.now);
  return JSON.stringify({ decision: 'block', reason: BLOCK_REASON });
}

/** Reads the hook's JSON from stdin (at most 1 MiB); null on anything else. */
export async function readHookInput(stream: AsyncIterable<Uint8Array> = process.stdin): Promise<StopHookInput | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
