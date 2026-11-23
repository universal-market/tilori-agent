// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import crypto from "node:crypto";
import type { Level } from "./policy.ts";

export const MAX_COUNT = 999999;
export const MAX_REFS_IN_LINE = 8;
export const DEFAULT_MAX_LINE_LENGTH = 512;
export const DEFAULT_MAX_DIGEST_LENGTH = 2000;
export const DEFAULT_WAKES_PER_HOUR = 12;

// Whole-string ASCII-only patterns WITHOUT the `m` flag.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const JSON_INT_SOURCE_RE = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Boxed representation of a JSON number literal containing a fractional or
 * exponent part (e.g. `1.0`, `1.5`, `1e2`). Preserves the float vs integer
 * distinction across JSON parsing so strict integer checks (`scrubCount`,
 * `parseConfig`, `RateLimiter`) refuse `1.0` as a non-integer.
 */
export class JsonFloat {
  readonly value: number;
  readonly source: string;

  constructor(value: number, source: string) {
    this.value = value;
    this.source = source;
  }

  valueOf(): number {
    return this.value;
  }
}

/**
 * Parse JSON while preserving float literals (including `1.0` and `1e2`) as
 * `JsonFloat` instances so true-integer validators reject them.
 */
export function parseJsonStrict(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (
      typeof value === "number" &&
      context !== undefined &&
      typeof context.source === "string" &&
      !JSON_INT_SOURCE_RE.test(context.source)
    ) {
      return new JsonFloat(value, context.source);
    }
    return value;
  });
}

// Control & bidi character patterns.
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL_OR_BIDI_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_OR_BIDI_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const DIGEST_DELIMITER_RE = /<<<(?:END_)?WAKEWISE_UNTRUSTED_DIGEST_[^>]*>>>/gi;
const DIGEST_PREFIX_RE = /<<<(?:END_)?WAKEWISE_UNTRUSTED_DIGEST/gi;
const UUID_TOKEN_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export type ScrubResult<T> =
  | { readonly accepted: true; readonly value: T }
  | { readonly accepted: false; readonly reason: string };

export function scrubId(value: unknown): ScrubResult<string> {
  if (typeof value === "string" && UUID_RE.test(value)) {
    return { accepted: true, value };
  }
  return { accepted: false, reason: "invalid_id" };
}

export function scrubKind(value: unknown): ScrubResult<string> {
  if (typeof value === "string" && KIND_RE.test(value)) {
    return { accepted: true, value };
  }
  return { accepted: false, reason: "invalid_kind" };
}

export function scrubCount(
  value: unknown,
  rawJsonSource?: string
): ScrubResult<number> {
  if (rawJsonSource !== undefined && !JSON_INT_SOURCE_RE.test(rawJsonSource)) {
    return { accepted: false, reason: "invalid_count" };
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { accepted: true, value: Math.min(value, MAX_COUNT) };
  }
  return { accepted: false, reason: "invalid_count" };
}

export function hasControlOrBidi(text: string): boolean {
  return CONTROL_OR_BIDI_RE.test(text);
}

export function stripControlAndBidi(text: string): string {
  return text
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_OSC_RE, "")
    .replace(CONTROL_OR_BIDI_GLOBAL_RE, "");
}

export interface RawOccurrence {
  readonly id?: unknown;
  readonly kind?: unknown;
}

export interface FormatWakeLineOptions {
  readonly occurrences: readonly RawOccurrence[];
  readonly kindPriority?: readonly string[];
  readonly maxLineLength?: number;
  readonly unreadCount?: unknown;
  readonly heldOverflowCount?: unknown;
  readonly wakesPerHour?: number;
}

export interface WakeLineResult {
  readonly line: string;
  readonly renderedRefs: readonly string[];
  readonly refCount: number;
  readonly omittedRefCount: number;
  readonly rejectedIds: readonly unknown[];
  readonly rejectedKinds: readonly unknown[];
}

interface CleanRef {
  readonly kind: string;
  readonly id: string;
}

function renderWakeLineText(
  allRefs: readonly CleanRef[],
  kindCounts: readonly (readonly [string, number])[],
  shownCount: number,
  includeNotice: boolean,
  unreadCount: number,
  includeUnread: boolean,
  heldOverflowCount: number,
  includeHeld: boolean,
  wakesPerHour: number
): string {
  const clauses: string[] = [];
  const totalRefs = allRefs.length;

  if (totalRefs > 0) {
    const eventWord = totalRefs === 1 ? "event" : "events";
    const kindSummary = kindCounts.map(([k, c]) => `${c} ${k}`).join(", ");
    const omitted = totalRefs - shownCount;

    if (shownCount > 0) {
      const refs = allRefs
        .slice(0, shownCount)
        .map((r) => `${r.kind} ${r.id}`)
        .join(", ");
      if (omitted > 0) {
        clauses.push(
          `${totalRefs} new ${eventWord} (${kindSummary}): ${refs} (+${omitted} more).`
        );
      } else {
        clauses.push(`${totalRefs} new ${eventWord} (${kindSummary}): ${refs}.`);
      }
    } else {
      clauses.push(`${totalRefs} new ${eventWord} (${kindSummary}, +${omitted} more).`);
    }
  }

  if (includeNotice) {
    clauses.push(
      "Notice only; it carries no event text. Fetch these ids with your own tools."
    );
  }

  if (includeUnread && unreadCount > 0) {
    const unreadWord = unreadCount === 1 ? "event" : "events";
    clauses.push(`You also have ${unreadCount} unread ${unreadWord}.`);
  }

  if (includeHeld && heldOverflowCount > 0) {
    const verb = heldOverflowCount === 1 ? "is" : "are";
    clauses.push(
      `${heldOverflowCount} more ${verb} waiting behind your limit of ${wakesPerHour} per hour (wakesPerHour); held items join the next wake.`
    );
  }

  return clauses.join(" ");
}

export function formatWakeLine(options: FormatWakeLineOptions): WakeLineResult {
  const kindPriority = options.kindPriority ?? [];
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const wakesPerHour = options.wakesPerHour ?? DEFAULT_WAKES_PER_HOUR;

  const unreadScrub = scrubCount(options.unreadCount ?? 0);
  const unreadCount = unreadScrub.accepted ? unreadScrub.value : 0;

  const heldScrub = scrubCount(options.heldOverflowCount ?? 0);
  const heldOverflowCount = heldScrub.accepted ? heldScrub.value : 0;

  const rejectedIds: unknown[] = [];
  const rejectedKinds: unknown[] = [];
  const seen = new Set<string>();
  const distinctRefs: CleanRef[] = [];

  for (const occ of options.occurrences) {
    const idRes = scrubId(occ.id);
    const kindRes = scrubKind(occ.kind);
    if (!idRes.accepted) {
      rejectedIds.push(occ.id);
    }
    if (!kindRes.accepted) {
      rejectedKinds.push(occ.kind);
    }
    if (!idRes.accepted || !kindRes.accepted) {
      continue;
    }
    const key = `${kindRes.value}\0${idRes.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinctRefs.push({ kind: kindRes.value, id: idRes.value });
    }
  }

  const priorityIndex = new Map<string, number>();
  for (let i = 0; i < kindPriority.length; i += 1) {
    if (!priorityIndex.has(kindPriority[i])) {
      priorityIndex.set(kindPriority[i], i);
    }
  }

  distinctRefs.sort((a, b) => {
    const pa = priorityIndex.get(a.kind);
    const pb = priorityIndex.get(b.kind);
    if (pa !== undefined && pb !== undefined) {
      if (pa !== pb) {
        return pa - pb;
      }
    } else if (pa !== undefined) {
      return -1;
    } else if (pb !== undefined) {
      return 1;
    }
    if (a.kind < b.kind) {
      return -1;
    }
    if (a.kind > b.kind) {
      return 1;
    }
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });

  const kindCountMap = new Map<string, number>();
  for (const ref of distinctRefs) {
    kindCountMap.set(ref.kind, (kindCountMap.get(ref.kind) ?? 0) + 1);
  }
  const kindCounts = Array.from(kindCountMap.entries());

  let shownCount = Math.min(distinctRefs.length, MAX_REFS_IN_LINE);
  let includeNotice = true;
  let includeUnread = unreadCount > 0;
  let includeHeld = heldOverflowCount > 0;

  let line = renderWakeLineText(
    distinctRefs,
    kindCounts,
    shownCount,
    includeNotice,
    unreadCount,
    includeUnread,
    heldOverflowCount,
    includeHeld,
    wakesPerHour
  );

  while (line.length > maxLineLength && shownCount > 0) {
    shownCount -= 1;
    line = renderWakeLineText(
      distinctRefs,
      kindCounts,
      shownCount,
      includeNotice,
      unreadCount,
      includeUnread,
      heldOverflowCount,
      includeHeld,
      wakesPerHour
    );
  }

  if (line.length > maxLineLength && includeNotice) {
    includeNotice = false;
    line = renderWakeLineText(
      distinctRefs,
      kindCounts,
      shownCount,
      includeNotice,
      unreadCount,
      includeUnread,
      heldOverflowCount,
      includeHeld,
      wakesPerHour
    );
  }

  if (line.length > maxLineLength && includeUnread) {
    includeUnread = false;
    line = renderWakeLineText(
      distinctRefs,
      kindCounts,
      shownCount,
      includeNotice,
      unreadCount,
      includeUnread,
      heldOverflowCount,
      includeHeld,
      wakesPerHour
    );
  }

  if (line.length > maxLineLength && includeHeld) {
    includeHeld = false;
    line = renderWakeLineText(
      distinctRefs,
      kindCounts,
      shownCount,
      includeNotice,
      unreadCount,
      includeUnread,
      heldOverflowCount,
      includeHeld,
      wakesPerHour
    );
  }

  if (line.length > maxLineLength && distinctRefs.length > 0) {
    const eventWord = distinctRefs.length === 1 ? "event" : "events";
    const minimal = `${distinctRefs.length} new ${eventWord}.`;
    line = minimal.length <= maxLineLength ? minimal : "";
  } else if (line.length > maxLineLength) {
    line = "";
  }

  const renderedRefs = distinctRefs
    .slice(0, shownCount)
    .map((r) => `${r.kind} ${r.id}`);

  return {
    line,
    renderedRefs,
    refCount: renderedRefs.length,
    omittedRefCount: distinctRefs.length - renderedRefs.length,
    rejectedIds,
    rejectedKinds,
  };
}

export interface FormatDigestOptions {
  readonly items: readonly RawOccurrence[];
  readonly rawSummary: string;
  readonly nonce?: string;
  readonly maxDigestLength?: number;
  readonly effectiveLevel?: Level;
}

export interface DigestResult {
  readonly wrapped: string;
  readonly body: string;
  readonly effectiveLevel: "digest";
  readonly causesWake: false;
}

export function formatDigest(options: FormatDigestOptions): DigestResult {
  const nonce = options.nonce ?? crypto.randomBytes(8).toString("hex");
  const maxDigestLength = options.maxDigestLength ?? DEFAULT_MAX_DIGEST_LENGTH;

  const validInputIds = new Set<string>();
  for (const item of options.items) {
    const res = scrubId(item.id);
    if (res.accepted) {
      validInputIds.add(res.value);
    }
  }

  let body = options.rawSummary;
  let prev: string;
  do {
    prev = body;
    body = stripControlAndBidi(body);
    let beforeDelim: string;
    do {
      beforeDelim = body;
      body = body.replace(DIGEST_DELIMITER_RE, "");
    } while (body !== beforeDelim);
    body = body.replace(DIGEST_PREFIX_RE, "");
    body = body.replace(UUID_TOKEN_RE, (token) =>
      validInputIds.has(token) ? token : ""
    );
  } while (body !== prev);

  if (body.length > maxDigestLength) {
    body = body.slice(0, maxDigestLength);
  }

  const startTag = `<<<WAKEWISE_UNTRUSTED_DIGEST_${nonce}>>>`;
  const endTag = `<<<END_WAKEWISE_UNTRUSTED_DIGEST_${nonce}>>>`;
  const wrapped = `${startTag}\n${body}\n${endTag}`;

  return {
    wrapped,
    body,
    effectiveLevel: "digest",
    causesWake: false,
  };
}
