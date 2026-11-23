// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import { isLevel } from "./policy.ts";
import type { Level } from "./policy.ts";
import { DEFAULT_POLL_MS, validateCursor } from "./cursor.ts";
import { scrubCount } from "./line.ts";

export interface ServerOccurrence {
  readonly id: string;
  readonly kind: string;
  readonly recipient?: string | null;
  readonly levelHint?: Level;
  readonly occurredAt?: string;
  readonly summary?: string;
  readonly _meta?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface WithLevelOptions {
  readonly direct?: boolean;
}

export interface BuildPollResponseOptions {
  readonly events: readonly Record<string, unknown>[];
  readonly cursor?: string | null;
  readonly truncated?: boolean;
  readonly nextPollMs?: number;
  readonly unreadCount?: number;
}

export interface BuiltPollResponse {
  readonly events: readonly Record<string, unknown>[];
  readonly cursor?: string | null;
  readonly truncated: boolean;
  readonly nextPollMs: number;
  readonly unreadCount?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attach a server-side `levelHint` to an occurrence and optionally write
 * `_meta.direct` for non-Wakewise consumers.
 * Wakewise clients ignore `_meta.direct` for lane selection and enforce
 * `effectiveLevel = min(levelHint, clientLevel)` so client settings always win.
 */
export function withLevel<T extends Record<string, unknown>>(
  occurrence: T,
  level: Level,
  options: WithLevelOptions = {}
): T & { readonly levelHint: Level; readonly _meta?: Record<string, unknown> } {
  if (!isPlainObject(occurrence)) {
    throw new TypeError("occurrence: must be an object");
  }
  if (!isLevel(level)) {
    throw new RangeError(
      `level: "${String(level)}" is not one of wake, digest, count, mute`
    );
  }
  if (options.direct !== undefined && typeof options.direct !== "boolean") {
    throw new TypeError("options.direct: must be a boolean");
  }

  const copy: Record<string, unknown> = { ...occurrence, levelHint: level };
  if (options.direct !== undefined) {
    const existingMeta = isPlainObject(occurrence._meta) ? occurrence._meta : {};
    copy._meta = { ...existingMeta, direct: options.direct };
  }
  return copy as T & {
    readonly levelHint: Level;
    readonly _meta?: Record<string, unknown>;
  };
}

/**
 * Build a minimal, schema-conformant `events/poll` JSON response object.
 */
export function buildPollResponse(
  options: BuildPollResponseOptions
): BuiltPollResponse {
  if (!Array.isArray(options.events)) {
    throw new TypeError("events: must be an array");
  }
  const truncated = options.truncated ?? false;
  if (typeof truncated !== "boolean") {
    throw new TypeError("truncated: must be a boolean");
  }
  const nextPollMs = options.nextPollMs ?? DEFAULT_POLL_MS;
  if (typeof nextPollMs !== "number" || !Number.isInteger(nextPollMs) || nextPollMs < 0) {
    throw new RangeError("nextPollMs: must be a non-negative integer");
  }

  if (options.cursor !== undefined && options.cursor !== null) {
    const checked = validateCursor(options.cursor);
    if (checked.resetToFresh || checked.cursor === null) {
      throw new RangeError("cursor: must be a valid non-empty cursor string");
    }
  }

  const response: {
    events: readonly Record<string, unknown>[];
    cursor?: string | null;
    truncated: boolean;
    nextPollMs: number;
    unreadCount?: number;
  } = {
    events: [...options.events],
    truncated,
    nextPollMs,
  };

  if (options.cursor !== undefined) {
    response.cursor = options.cursor;
  }

  if (options.unreadCount !== undefined) {
    const countCheck = scrubCount(options.unreadCount);
    if (!countCheck.accepted) {
      throw new RangeError("unreadCount: must be a non-negative integer");
    }
    response.unreadCount = countCheck.value;
  }

  return response;
}
