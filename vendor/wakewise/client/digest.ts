// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import crypto from "node:crypto";
import {
  DEFAULT_MAX_DIGEST_LENGTH,
  formatDigest,
  scrubId,
  scrubKind,
  stripControlAndBidi,
} from "./line.ts";
import type { DigestResult } from "./line.ts";

export const MAX_DIGEST_ITEM_SUMMARY_LENGTH = 1000;
export const MAX_DIGEST_ITEM_TIMESTAMP_LENGTH = 64;

export interface DigestItem {
  readonly id: string;
  readonly kind: string;
  readonly summary?: string;
  readonly occurredAt?: string;
}

export type DigestSummarizer = (items: readonly DigestItem[]) => string;
export type AsyncDigestSummarizer = (
  items: readonly DigestItem[]
) => string | Promise<string>;

export interface LocalDigestOptions {
  readonly items: readonly Record<string, unknown>[];
  readonly summarize: DigestSummarizer;
  readonly nonce?: string;
  readonly maxDigestLength?: number;
}

export interface AsyncLocalDigestOptions {
  readonly items: readonly Record<string, unknown>[];
  readonly summarize: AsyncDigestSummarizer;
  readonly nonce?: string;
  readonly maxDigestLength?: number;
}

export class DigestAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestAdapterError";
  }
}

/**
 * Scrub and bound raw occurrence items before handing them to a local summarizer.
 * Strips all extra fields (_meta, secrets, credentials, env, tools) and freezes each item.
 */
export function sanitizeDigestItems(
  rawItems: readonly Record<string, unknown>[]
): readonly DigestItem[] {
  const clean: DigestItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const idRes = scrubId(raw.id);
    const kindRes = scrubKind(raw.kind);
    if (!idRes.accepted || !kindRes.accepted) {
      continue;
    }
    const item: {
      id: string;
      kind: string;
      summary?: string;
      occurredAt?: string;
    } = {
      id: idRes.value,
      kind: kindRes.value,
    };
    if (typeof raw.summary === "string") {
      const cleanSummary = stripControlAndBidi(raw.summary);
      item.summary =
        cleanSummary.length > MAX_DIGEST_ITEM_SUMMARY_LENGTH
          ? cleanSummary.slice(0, MAX_DIGEST_ITEM_SUMMARY_LENGTH)
          : cleanSummary;
    }
    if (typeof raw.occurredAt === "string") {
      const cleanTs = stripControlAndBidi(raw.occurredAt);
      item.occurredAt =
        cleanTs.length > MAX_DIGEST_ITEM_TIMESTAMP_LENGTH
          ? cleanTs.slice(0, MAX_DIGEST_ITEM_TIMESTAMP_LENGTH)
          : cleanTs;
    }
    clean.push(Object.freeze(item));
  }
  return Object.freeze(clean);
}

function generateNonce(): string {
  return crypto.randomBytes(12).toString("hex");
}

function wrapDigestOutput(
  sanitizedItems: readonly DigestItem[],
  rawSummary: unknown,
  nonce: string | undefined,
  maxDigestLength: number
): DigestResult {
  if (typeof rawSummary !== "string") {
    throw new DigestAdapterError("summarize(items) must return a string");
  }
  return formatDigest({
    items: sanitizedItems,
    rawSummary,
    nonce: nonce ?? generateNonce(),
    maxDigestLength,
    effectiveLevel: "digest",
  });
}

/**
 * Local digest adapter (0.1 local-only; no hosted adapter).
 * Calls `summarize(items)` with ONLY scrubbed items (no tools, no env, no secrets),
 * wraps the output with an unforgeable nonce delimiter, strips control+bidi and
 * forged delimiters to fixpoint, caps length, and drops uncited/hallucinated UUIDs.
 * Never changes effective level or triggers a wake.
 */
export function runLocalDigest(options: LocalDigestOptions): DigestResult {
  if (typeof options.summarize !== "function") {
    throw new DigestAdapterError("summarize must be a function");
  }
  const sanitizedItems = sanitizeDigestItems(options.items);
  const rawSummary = options.summarize(sanitizedItems);
  return wrapDigestOutput(
    sanitizedItems,
    rawSummary,
    options.nonce,
    options.maxDigestLength ?? DEFAULT_MAX_DIGEST_LENGTH
  );
}

/**
 * Async variant of the local digest adapter (supports command-backed local summarizers).
 */
export async function runLocalDigestAsync(
  options: AsyncLocalDigestOptions
): Promise<DigestResult> {
  if (typeof options.summarize !== "function") {
    throw new DigestAdapterError("summarize must be a function");
  }
  const sanitizedItems = sanitizeDigestItems(options.items);
  const rawSummary = await options.summarize(sanitizedItems);
  return wrapDigestOutput(
    sanitizedItems,
    rawSummary,
    options.nonce,
    options.maxDigestLength ?? DEFAULT_MAX_DIGEST_LENGTH
  );
}
