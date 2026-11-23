// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasControlOrBidi } from "./line.ts";

export const MAX_CURSOR_LENGTH = 512;
export const MAX_CURSOR_FILE_BYTES = 4096;
export const MIN_POLL_MS = 1000;
export const DEFAULT_MAX_POLL_MS = 300000;
export const DEFAULT_POLL_MS = 5000;

export interface CursorLoadResult {
  readonly cursor: string | null;
  readonly resetToFresh: boolean;
}

export interface PollResponse {
  readonly events?: readonly unknown[];
  readonly cursor?: unknown;
  readonly truncated?: boolean;
  readonly nextPollMs?: unknown;
  readonly unreadCount?: unknown;
}

export interface UpdateCursorResult {
  readonly nextCursor: string | null;
  readonly catchUpPolls: number;
  readonly clampedPollMs: number;
  readonly resetToFresh: boolean;
  readonly badCursor: boolean;
  readonly badCursorReason: "null_cursor" | "invalid_cursor" | null;
}

export interface PollCycleResult {
  readonly totalPolls: number;
  readonly catchUpPolls: number;
  readonly nextCursor: string | null;
  readonly clampedPollMs: number;
  readonly events: readonly unknown[];
  readonly resetToFresh: boolean;
  readonly badCursor: boolean;
  readonly badCursorReasons: readonly ("null_cursor" | "invalid_cursor")[];
}

export class CursorSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorSecurityError";
  }
}

export function validateCursor(raw: unknown): CursorLoadResult {
  if (raw === null || raw === undefined) {
    return { cursor: null, resetToFresh: false };
  }
  if (typeof raw !== "string") {
    return { cursor: null, resetToFresh: true };
  }
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    return { cursor: null, resetToFresh: true };
  }
  if (hasControlOrBidi(raw)) {
    return { cursor: null, resetToFresh: true };
  }
  return { cursor: raw, resetToFresh: false };
}

export function parseCursorPayload(rawFileContent: string): CursorLoadResult {
  if (Buffer.byteLength(rawFileContent, "utf8") > MAX_CURSOR_FILE_BYTES) {
    return { cursor: null, resetToFresh: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFileContent);
  } catch {
    return { cursor: null, resetToFresh: true };
  }

  if (parsed === null) {
    return { cursor: null, resetToFresh: false };
  }
  if (typeof parsed === "string") {
    return validateCursor(parsed);
  }
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (!("cursor" in obj)) {
      return { cursor: null, resetToFresh: true };
    }
    return validateCursor(obj.cursor);
  }
  return { cursor: null, resetToFresh: true };
}

export function clampNextPollMs(
  nextPollMs: unknown,
  maxPollMs: number = DEFAULT_MAX_POLL_MS
): number {
  const ceiling =
    typeof maxPollMs === "number" &&
    Number.isInteger(maxPollMs) &&
    maxPollMs >= MIN_POLL_MS
      ? maxPollMs
      : DEFAULT_MAX_POLL_MS;

  if (
    typeof nextPollMs !== "number" ||
    !Number.isInteger(nextPollMs) ||
    nextPollMs < 0
  ) {
    return Math.min(Math.max(DEFAULT_POLL_MS, MIN_POLL_MS), ceiling);
  }

  if (nextPollMs < MIN_POLL_MS) {
    return MIN_POLL_MS;
  }
  if (nextPollMs > ceiling) {
    return ceiling;
  }
  return nextPollMs;
}

export function updateCursor(
  currentCursor: string | null,
  pollResponse: PollResponse,
  maxPollMs: number = DEFAULT_MAX_POLL_MS
): UpdateCursorResult {
  let nextCursor: string | null = currentCursor;
  const resetToFresh = false;
  let badCursor = false;
  let badCursorReason: "null_cursor" | "invalid_cursor" | null = null;

  if ("cursor" in pollResponse && pollResponse.cursor !== undefined) {
    if (pollResponse.cursor === null) {
      // Server returned null cursor: keep currentCursor, do NOT reset to fresh, report bad cursor.
      badCursor = true;
      badCursorReason = "null_cursor";
    } else {
      const validated = validateCursor(pollResponse.cursor);
      if (validated.resetToFresh || validated.cursor === null) {
        // Server returned invalid cursor: keep currentCursor, do NOT reset to fresh, report bad cursor.
        badCursor = true;
        badCursorReason = "invalid_cursor";
      } else {
        nextCursor = validated.cursor;
      }
    }
  }

  const clampedPollMs = clampNextPollMs(pollResponse.nextPollMs, maxPollMs);
  const catchUpPolls = pollResponse.truncated === true ? 1 : 0;

  return {
    nextCursor,
    catchUpPolls,
    clampedPollMs,
    resetToFresh,
    badCursor,
    badCursorReason,
  };
}

/**
 * Process a poll cycle with at most ONE bounded catch-up poll when truncated=true.
 */
export function runPollCycle(
  initialCursor: string | null,
  responses: readonly PollResponse[],
  maxPollMs: number = DEFAULT_MAX_POLL_MS
): PollCycleResult {
  if (responses.length === 0) {
    return {
      totalPolls: 0,
      catchUpPolls: 0,
      nextCursor: initialCursor,
      clampedPollMs: clampNextPollMs(undefined, maxPollMs),
      events: [],
      resetToFresh: false,
      badCursor: false,
      badCursorReasons: [],
    };
  }

  const first = responses[0];
  const firstUpdate = updateCursor(initialCursor, first, maxPollMs);
  const events: unknown[] = [...(first.events ?? [])];
  const badCursorReasons: ("null_cursor" | "invalid_cursor")[] = [];
  if (firstUpdate.badCursorReason !== null) {
    badCursorReasons.push(firstUpdate.badCursorReason);
  }
  let totalPolls = 1;
  let catchUpPolls = 0;
  let nextCursor = firstUpdate.nextCursor;
  let clampedPollMs = firstUpdate.clampedPollMs;
  let resetToFresh = firstUpdate.resetToFresh;

  if (first.truncated === true && responses.length > 1) {
    const second = responses[1];
    const secondUpdate = updateCursor(nextCursor, second, maxPollMs);
    events.push(...(second.events ?? []));
    if (secondUpdate.badCursorReason !== null) {
      badCursorReasons.push(secondUpdate.badCursorReason);
    }
    totalPolls = 2;
    catchUpPolls = 1;
    nextCursor = secondUpdate.nextCursor;
    clampedPollMs = secondUpdate.clampedPollMs;
    resetToFresh = secondUpdate.resetToFresh;
  }

  return {
    totalPolls,
    catchUpPolls,
    nextCursor,
    clampedPollMs,
    events,
    resetToFresh,
    badCursor: badCursorReasons.length > 0,
    badCursorReasons,
  };
}

function assertSafeCursorFdStats(
  stats: fs.Stats,
  label: string,
  targetPath: string,
  expectDir: boolean
): void {
  if (expectDir ? !stats.isDirectory() : !stats.isFile()) {
    throw new CursorSecurityError(
      `${label}: expected a ${expectDir ? "directory" : "regular file"}`
    );
  }
  if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
    throw new CursorSecurityError(`${label}: refusing foreign-owned path`);
  }
  const expectedMode = expectDir ? 0o700 : 0o600;
  const expectedModeStr = `0${expectedMode.toString(8).padStart(3, "0")}`;
  const actualMode = stats.mode & 0o777;
  const actualModeStr = `0${actualMode.toString(8).padStart(3, "0")}`;
  if ((actualMode & 0o022) !== 0) {
    const kind = expectDir ? "parent directory" : "cursor file";
    throw new CursorSecurityError(
      `${label}: refusing group-writable or world-writable ${kind} ${targetPath}; fix with: chmod ${expectedModeStr} ${targetPath}`
    );
  }
  if (actualMode !== expectedMode) {
    throw new CursorSecurityError(
      `${label}: expected mode ${expectedModeStr} for ${targetPath}, got ${actualModeStr}; fix with: chmod ${expectedModeStr} ${targetPath}`
    );
  }
}

function readBoundedFd(fd: number, maxBytes: number): { bytes: Buffer; exceeded: boolean } {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(Math.min(maxBytes + 1, 4097));

  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
    if (n === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }

  if (total > maxBytes) {
    return { bytes: Buffer.alloc(0), exceeded: true };
  }
  return { bytes: Buffer.concat(chunks, total), exceeded: false };
}

/**
 * Read persisted cursor file securely:
 * opens parent dir and file with O_NOFOLLOW, fstats both open fds,
 * enforces owner == euid, dir mode 0700, file mode 0600, and reads at most 4096 bytes.
 */
export function readCursorFile(filePath: string): CursorLoadResult {
  const dirPath = path.dirname(filePath);
  const dirFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);

  let dirFd: number;
  try {
    dirFd = fs.openSync(dirPath, dirFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { cursor: null, resetToFresh: false };
    }
    if (code === "ELOOP") {
      throw new CursorSecurityError("cursorDir: refusing symlink");
    }
    if (code === "ENOTDIR") {
      throw new CursorSecurityError("cursorDir: expected a directory");
    }
    throw err;
  }

  try {
    const dirStats = fs.fstatSync(dirFd);
    assertSafeCursorFdStats(dirStats, "cursorDir", dirPath, true);
  } finally {
    fs.closeSync(dirFd);
  }

  const fileFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);

  let fd: number;
  try {
    fd = fs.openSync(filePath, fileFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { cursor: null, resetToFresh: false };
    }
    if (code === "ELOOP") {
      throw new CursorSecurityError("cursorPath: refusing symlink");
    }
    throw err;
  }

  let content: string;
  try {
    const stats = fs.fstatSync(fd);
    assertSafeCursorFdStats(stats, "cursorPath", filePath, false);

    const { bytes, exceeded } = readBoundedFd(fd, MAX_CURSOR_FILE_BYTES);
    if (exceeded) {
      return { cursor: null, resetToFresh: true };
    }
    content = bytes.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  return parseCursorPayload(content);
}

export function writeCursorFile(filePath: string, cursor: string | null): void {
  if (cursor !== null) {
    const checked = validateCursor(cursor);
    if (checked.resetToFresh) {
      throw new Error("cursor: invalid cursor value");
    }
  }

  const dirPath = path.dirname(filePath);
  const dirFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);

  let dirExists = false;
  try {
    const dirFd = fs.openSync(dirPath, dirFlags);
    try {
      const dirStats = fs.fstatSync(dirFd);
      assertSafeCursorFdStats(dirStats, "cursorDir", dirPath, true);
    } finally {
      fs.closeSync(dirFd);
    }
    dirExists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new CursorSecurityError("cursorDir: refusing symlink");
    }
    if (code === "ENOTDIR") {
      throw new CursorSecurityError("cursorDir: expected a directory");
    }
    if (code !== "ENOENT") {
      throw err;
    }
  }

  if (!dirExists) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(dirPath, 0o700);
  }

  const fileFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);

  try {
    const existingFd = fs.openSync(filePath, fileFlags);
    try {
      const existingStats = fs.fstatSync(existingFd);
      assertSafeCursorFdStats(existingStats, "cursorPath", filePath, false);
    } finally {
      fs.closeSync(existingFd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new CursorSecurityError("cursorPath: refusing symlink");
    }
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const tmpName = `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = path.join(dirPath, tmpName);
  const payload = JSON.stringify({ cursor }) + "\n";

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, flags, 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}
