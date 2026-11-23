// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import { parseConfig } from "./config.ts";
import type { WakewiseConfig } from "./config.ts";
import {
  DEFAULT_MAX_POLL_MS,
  clampNextPollMs,
  readCursorFile,
  updateCursor,
  writeCursorFile,
} from "./cursor.ts";
import type { PollResponse } from "./cursor.ts";
import { RateLimiter } from "./limiter.ts";
import type { EventRef, LimiterDecision } from "./limiter.ts";
import {
  MAX_COUNT,
  formatWakeLine,
  parseJsonStrict,
  scrubCount,
  scrubId,
  scrubKind,
  stripControlAndBidi,
} from "./line.ts";
import type { DigestResult, WakeLineResult } from "./line.ts";
import { LEVEL_ORDER, effectiveLevel, evaluatePolicy, isLevel, selectLane } from "./policy.ts";
import type { Lane, Level } from "./policy.ts";
import { runLocalDigestAsync } from "./digest.ts";
import type { AsyncDigestSummarizer, DigestItem } from "./digest.ts";

export const MAX_POLL_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_SAME_ORIGIN_REDIRECTS = 2;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 2000;
export const MAX_CLASSIFY_PER_POLL = 64;
/** Upper bound for classifyTimeoutMs (setTimeout overflows above 2^31-1). */
export const MAX_CLASSIFY_TIMEOUT_MS = 60000;
/** Total wall-clock budget for classify calls in one pollOnce. */
export const CLASSIFY_POLL_BUDGET_MS = 10000;
const MAX_CLASSIFY_ERROR_CHARS = 200;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

export class ClientTransportError extends ClientError {
  constructor(message: string) {
    super(message);
    this.name = "ClientTransportError";
  }
}

export class ClientProtocolError extends ClientError {
  constructor(message: string) {
    super(message);
    this.name = "ClientProtocolError";
  }
}

export interface TransportRequest {
  readonly url: string;
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}

export type PollTransport = (
  request: TransportRequest
) => Promise<TransportResponse>;

export interface WakeDelivery {
  readonly lane: Lane;
  readonly refs: readonly EventRef[];
  readonly heldOverflowCount: number;
  readonly unreadCount: number;
  readonly formatted: WakeLineResult;
  readonly line: string;
}

export interface BadCursorReport {
  readonly reason: "null_cursor" | "invalid_cursor";
  readonly keptCursor: string | null;
}

export interface ClassifyErrorReport {
  readonly id: string;
  readonly kind: string;
  readonly reason: "invalid_level" | "threw" | "timeout";
  readonly message: string;
}

export type ContentClassifier = (
  event: Readonly<Record<string, unknown>>
) => Level | Promise<Level>;

export interface PollOutcome {
  readonly pollsMade: number;
  readonly catchUpPolls: number;
  readonly cursor: string | null;
  readonly nextPollMs: number;
  readonly badCursors: readonly BadCursorReport[];
  readonly classifyErrors: readonly ClassifyErrorReport[];
  readonly wakes: readonly WakeDelivery[];
  readonly digests: readonly DigestResult[];
  readonly heldCount: number;
  readonly heldOverflowCount: number;
  readonly unreadCount: number;
  readonly decisions: readonly LimiterDecision[];
}

export interface WakewiseClientOptions {
  readonly config: WakewiseConfig | Record<string, unknown>;
  readonly token?: string;
  readonly transport?: PollTransport;
  readonly clock?: () => number;
  readonly onWake?: (wake: WakeDelivery) => void | Promise<void>;
  readonly onDigest?: (
    digest: DigestResult,
    items: readonly DigestItem[]
  ) => void | Promise<void>;
  readonly summarize?: AsyncDigestSummarizer;
  readonly classify?: ContentClassifier;
  readonly classifyTimeoutMs?: number;
  readonly onClassifyError?: (report: ClassifyErrorReport) => void;
  readonly onBadCursor?: (report: BadCursorReport) => void;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly initialCursor?: string | null;
  readonly persistCursor?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redact a credential token (raw, URL-encoded, and Authorization Bearer forms) from text.
 */
export function redactToken(text: string, token?: string | null): string {
  let out = text;
  if (typeof token === "string" && token.length > 0) {
    out = out.split(token).join("[REDACTED]");
    const encoded = encodeURIComponent(token);
    if (encoded !== token && encoded.length > 0) {
      out = out.split(encoded).join("[REDACTED]");
    }
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return out;
}

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]"
  );
}

function normalizedOrigin(url: URL): string {
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port || (scheme === "https:" ? "443" : "80");
  return `${scheme}//${host}:${port}`;
}

/**
 * Validate a poll URL:
 * - HTTPS required, except HTTP allowed strictly for loopback (127.0.0.1, ::1, localhost).
 * - Embedded credentials (user:pass@host) are forbidden.
 */
export function validatePollUrl(rawUrl: string, token?: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new ClientTransportError("endpoint: must be a non-empty URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ClientTransportError(
      redactToken(`endpoint: invalid URL "${rawUrl}"`, token)
    );
  }
  if (parsed.username || parsed.password) {
    throw new ClientTransportError(
      "endpoint: credentials are not allowed in URL"
    );
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  throw new ClientTransportError(
    "endpoint: must use https:// (http:// is allowed only for 127.0.0.1, ::1, localhost)"
  );
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return undefined;
}

/**
 * Default Node built-in `fetch` transport with `redirect: "manual"`,
 * AbortController timeout, and streaming response size cap.
 */
export const defaultFetchTransport: PollTransport = async (
  request: TransportRequest
): Promise<TransportResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      redirect: "manual",
      signal: controller.signal,
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let body: Uint8Array;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            total += value.byteLength;
            if (total > request.maxResponseBytes) {
              await reader.cancel().catch(() => {});
              throw new ClientProtocolError(
                `poll response exceeded max size of ${request.maxResponseBytes} bytes`
              );
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      body = Buffer.concat(chunks, total);
    } else {
      const arr = new Uint8Array(await response.arrayBuffer());
      if (arr.byteLength > request.maxResponseBytes) {
        throw new ClientProtocolError(
          `poll response exceeded max size of ${request.maxResponseBytes} bytes`
        );
      }
      body = arr;
    }

    return {
      status: response.status,
      headers,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
};

function parsePollResponseBody(
  body: Uint8Array | string,
  maxResponseBytes: number,
  token?: string
): PollResponse {
  const byteLength =
    typeof body === "string"
      ? Buffer.byteLength(body, "utf8")
      : body.byteLength;

  if (byteLength > maxResponseBytes) {
    throw new ClientProtocolError(
      `poll response exceeded max size of ${maxResponseBytes} bytes`
    );
  }

  const text =
    typeof body === "string" ? body : Buffer.from(body).toString("utf8");

  let parsed: unknown;
  try {
    parsed = parseJsonStrict(text);
  } catch {
    throw new ClientProtocolError(
      redactToken("poll response: invalid JSON body", token)
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ClientProtocolError("poll response: root must be a JSON object");
  }
  if (!Array.isArray(parsed.events)) {
    throw new ClientProtocolError("poll response: events must be an array");
  }

  return parsed as PollResponse;
}

function isWakewiseConfig(
  cfg: WakewiseConfig | Record<string, unknown>
): cfg is WakewiseConfig {
  return (
    isPlainObject(cfg) &&
    typeof cfg.defaultLevel === "string" &&
    Array.isArray(cfg.rules) &&
    typeof cfg.directLane === "boolean" &&
    isPlainObject(cfg.limits) &&
    typeof cfg.maxPollMs === "number"
  );
}

export class WakewiseClient {
  readonly config: WakewiseConfig;
  private readonly token?: string;
  private readonly transport: PollTransport;
  private readonly limiter: RateLimiter;
  private readonly onWake?: (wake: WakeDelivery) => void | Promise<void>;
  private readonly onDigest?: (
    digest: DigestResult,
    items: readonly DigestItem[]
  ) => void | Promise<void>;
  private readonly summarize?: AsyncDigestSummarizer;
  private readonly classify?: ContentClassifier;
  private readonly classifyTimeoutMs: number;
  private readonly onClassifyError?: (report: ClassifyErrorReport) => void;
  private readonly onBadCursor?: (report: BadCursorReport) => void;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly persistCursor: boolean;

  private cursor: string | null;

  constructor(options: WakewiseClientOptions) {
    this.config = isWakewiseConfig(options.config)
      ? options.config
      : parseConfig(options.config);

    if (!this.config.endpoint) {
      throw new ClientTransportError("config.endpoint is required");
    }
    validatePollUrl(this.config.endpoint, options.token);

    this.token = options.token;
    this.transport = options.transport ?? defaultFetchTransport;
    this.onWake = options.onWake;
    this.onDigest = options.onDigest;
    this.summarize = options.summarize;
    this.classify = options.classify;
    const classifyTimeoutMs =
      options.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
    if (
      typeof classifyTimeoutMs !== "number" ||
      !Number.isFinite(classifyTimeoutMs) ||
      classifyTimeoutMs <= 0 ||
      classifyTimeoutMs > MAX_CLASSIFY_TIMEOUT_MS
    ) {
      throw new ClientError(`classifyTimeoutMs: must be a positive number up to ${MAX_CLASSIFY_TIMEOUT_MS}`);
    }
    this.classifyTimeoutMs = classifyTimeoutMs;
    this.onClassifyError = options.onClassifyError;
    this.onBadCursor = options.onBadCursor;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_POLL_RESPONSE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.persistCursor =
      options.persistCursor ?? typeof this.config.cursorPath === "string";

    if (options.initialCursor !== undefined) {
      this.cursor = options.initialCursor;
    } else if (this.persistCursor && this.config.cursorPath) {
      const loaded = readCursorFile(this.config.cursorPath);
      this.cursor = loaded.cursor;
    } else {
      this.cursor = null;
    }

    this.limiter = new RateLimiter({
      selfId: this.config.selfId ?? null,
      directLane: this.config.directLane,
      directKinds: this.config.directKinds,
      alwaysWake: this.config.alwaysWake,
      limits: this.config.limits,
      clock: options.clock,
    });
  }

  getCursor(): string | null {
    return this.cursor;
  }

  getLimiter(): RateLimiter {
    return this.limiter;
  }

  private buildRequestUrl(cursor: string | null): URL {
    const url = validatePollUrl(this.config.endpoint!, this.token);
    if (cursor !== null) {
      url.searchParams.set("cursor", cursor);
    } else {
      url.searchParams.delete("cursor");
    }
    return url;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (typeof this.token === "string" && this.token.length > 0) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async fetchSinglePoll(cursor: string | null): Promise<PollResponse> {
    let currentUrl = this.buildRequestUrl(cursor);
    const initialOrigin = normalizedOrigin(currentUrl);
    const headers = this.buildHeaders();

    for (let redirectCount = 0; redirectCount <= MAX_SAME_ORIGIN_REDIRECTS; redirectCount += 1) {
      let resp: TransportResponse;
      try {
        resp = await this.transport({
          url: currentUrl.toString(),
          method: "GET",
          headers,
          timeoutMs: this.requestTimeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        });
      } catch (err) {
        if (err instanceof ClientError) {
          throw new (err.constructor as typeof ClientError)(
            redactToken(err.message, this.token)
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new ClientTransportError(
          redactToken(`poll transport failed: ${msg}`, this.token)
        );
      }

      if (REDIRECT_STATUSES.has(resp.status)) {
        const location = getHeaderCaseInsensitive(resp.headers, "location");
        if (!location) {
          throw new ClientTransportError(
            `poll redirect (${resp.status}) missing Location header`
          );
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new ClientTransportError("poll redirect has invalid Location URL");
        }
        validatePollUrl(nextUrl.toString(), this.token);

        if (normalizedOrigin(nextUrl) !== initialOrigin) {
          throw new ClientTransportError(
            "poll redirect refused: cross-origin redirect with credentials is forbidden"
          );
        }

        if (redirectCount >= MAX_SAME_ORIGIN_REDIRECTS) {
          throw new ClientTransportError(
            `poll redirect refused: exceeded maximum of ${MAX_SAME_ORIGIN_REDIRECTS} same-origin redirects`
          );
        }

        currentUrl = nextUrl;
        continue;
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new ClientTransportError(
          redactToken(`poll request failed with HTTP ${resp.status}`, this.token)
        );
      }

      return parsePollResponseBody(resp.body, this.maxResponseBytes, this.token);
    }

    throw new ClientTransportError(
      `poll redirect refused: exceeded maximum of ${MAX_SAME_ORIGIN_REDIRECTS} same-origin redirects`
    );
  }

  private async emitWakeFromDecision(
    decision: Extract<LimiterDecision, { decision: "wake" }>,
    unreadCount: number
  ): Promise<WakeDelivery> {
    const formatted = formatWakeLine({
      occurrences: decision.refs,
      kindPriority: this.config.kindPriority,
      maxLineLength: this.config.maxLineLength,
      unreadCount,
      heldOverflowCount: decision.heldOverflowCount,
      wakesPerHour: this.config.limits.wakesPerHour,
    });
    const delivery: WakeDelivery = {
      lane: decision.lane,
      refs: decision.refs,
      heldOverflowCount: decision.heldOverflowCount,
      unreadCount,
      formatted,
      line: formatted.line,
    };
    if (this.onWake) {
      await this.onWake(delivery);
    }
    return delivery;
  }

  private reportClassifyError(report: ClassifyErrorReport): void {
    if (this.onClassifyError) {
      // A throwing callback must not reject pollOnce: the cursor is already
      // persisted, so the batch would be lost.
      try {
        this.onClassifyError(report);
      } catch {
        // ignored by design
      }
    } else {
      const message = stripControlAndBidi(report.message).slice(0, MAX_CLASSIFY_ERROR_CHARS);
      process.stderr.write(`wakewise classify error (${report.reason}): ${message}\n`);
    }
  }

  private async runClassifyWithFloor(
    raw: Record<string, unknown>,
    id: string,
    kind: string,
    configuredLevel: Level,
    recipient: string | null | undefined,
    classifyErrors: ClassifyErrorReport[]
  ): Promise<Level> {
    if (!this.classify) {
      return configuredLevel;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => this.classify!(raw)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`classify timed out after ${this.classifyTimeoutMs} ms`));
          }, this.classifyTimeoutMs);
        }),
      ]);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = rawMsg.startsWith("classify timed out after");
      const report: ClassifyErrorReport = {
        id,
        kind,
        reason: isTimeout ? "timeout" : "threw",
        message: redactToken(rawMsg, this.token),
      };
      classifyErrors.push(report);
      this.reportClassifyError(report);
      return configuredLevel;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (!isLevel(result)) {
      const report: ClassifyErrorReport = {
        id,
        kind,
        reason: "invalid_level",
        message: redactToken(
          `classify returned invalid level: ${String(result)}`,
          this.token
        ),
      };
      classifyErrors.push(report);
      this.reportClassifyError(report);
      return configuredLevel;
    }

    // Mention/direct items may never be lowered below their configured floor.
    const lane = selectLane(
      { kind, recipient },
      {
        selfId: this.config.selfId,
        directLane: this.config.directLane,
        directKinds: this.config.directKinds,
        alwaysWake: this.config.alwaysWake,
      }
    );
    // alwaysWake kinds are the user's own must-wake list, so they are floored too.
    const isMentionOrDirect =
      lane === "direct" ||
      lane === "alwaysWake" ||
      kind === "mention" ||
      kind.startsWith("mention.");
    if (isMentionOrDirect && LEVEL_ORDER[result] < LEVEL_ORDER[configuredLevel]) {
      return configuredLevel;
    }

    return result;
  }

  /**
   * Perform one poll cycle (plus at most ONE bounded catch-up poll if `truncated: true`),
   * update the client-owned cursor, classify occurrences by client policy + levelHint,
   * enforce caps/lanes/pauseSeconds, and emit wakes/digests.
   */
  async pollOnce(): Promise<PollOutcome> {
    const maxPollMs = this.config.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    const badCursors: BadCursorReport[] = [];
    const classifyErrors: ClassifyErrorReport[] = [];
    const allEvents: unknown[] = [];

    const firstResp = await this.fetchSinglePoll(this.cursor);
    const firstUpdate = updateCursor(this.cursor, firstResp, maxPollMs);
    this.cursor = firstUpdate.nextCursor;
    if (firstUpdate.badCursor && firstUpdate.badCursorReason !== null) {
      const report: BadCursorReport = {
        reason: firstUpdate.badCursorReason,
        keptCursor: this.cursor,
      };
      badCursors.push(report);
      this.onBadCursor?.(report);
    }
    allEvents.push(...(firstResp.events ?? []));

    let pollsMade = 1;
    let catchUpPolls = 0;
    let nextPollMs = firstUpdate.clampedPollMs;
    let latestServerUnread = 0;
    const firstUnread = scrubCount(firstResp.unreadCount ?? 0);
    if (firstUnread.accepted) {
      latestServerUnread = firstUnread.value;
    }

    if (firstResp.truncated === true) {
      const secondResp = await this.fetchSinglePoll(this.cursor);
      const secondUpdate = updateCursor(this.cursor, secondResp, maxPollMs);
      this.cursor = secondUpdate.nextCursor;
      if (secondUpdate.badCursor && secondUpdate.badCursorReason !== null) {
        const report: BadCursorReport = {
          reason: secondUpdate.badCursorReason,
          keptCursor: this.cursor,
        };
        badCursors.push(report);
        this.onBadCursor?.(report);
      }
      allEvents.push(...(secondResp.events ?? []));
      pollsMade = 2;
      catchUpPolls = 1;
      nextPollMs = secondUpdate.clampedPollMs;
      const secondUnread = scrubCount(secondResp.unreadCount ?? 0);
      if (secondUnread.accepted) {
        latestServerUnread = secondUnread.value;
      }
    }

    if (this.persistCursor && this.config.cursorPath) {
      writeCursorFile(this.config.cursorPath, this.cursor);
    }

    let countedEvents = 0;
    const wakeCandidates: Array<{
      id: string;
      kind: string;
      recipient?: string | null;
    }> = [];
    const digestCandidates: Record<string, unknown>[] = [];

    let classifyCalls = 0;
    const classifyStart = Date.now();
    for (const raw of allEvents) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const idRes = scrubId(raw.id);
      const kindRes = scrubKind(raw.kind);
      if (!idRes.accepted || !kindRes.accepted) {
        continue;
      }
      const evalRes = evaluatePolicy(
        this.config.rules,
        kindRes.value,
        this.config.defaultLevel
      );
      let recipient: string | null | undefined;
      if (typeof raw.recipient === "string") {
        const recRes = scrubId(raw.recipient);
        if (recRes.accepted) {
          recipient = recRes.value;
        }
      } else if (raw.recipient === null) {
        recipient = null;
      }
      // A mute hint makes the effective level mute whatever classify says, so
      // skip the call; and bound classify calls per poll so a slow classifier
      // cannot stall one poll for N x timeout.
      const skipClassify =
        raw.levelHint === "mute" ||
        classifyCalls >= MAX_CLASSIFY_PER_POLL ||
        Date.now() - classifyStart >= CLASSIFY_POLL_BUDGET_MS;
      if (!skipClassify && this.classify) classifyCalls += 1;
      const classifiedLevel = skipClassify ? evalRes.level : await this.runClassifyWithFloor(
        raw,
        idRes.value,
        kindRes.value,
        evalRes.level,
        recipient,
        classifyErrors
      );
      const eff = effectiveLevel(classifiedLevel, raw.levelHint);
      if (eff === "mute") {
        continue;
      }
      if (eff === "count") {
        countedEvents += 1;
        continue;
      }
      if (eff === "digest") {
        digestCandidates.push(raw);
        continue;
      }
      // eff === "wake": pass ONLY validated fields (never `_meta`) to RateLimiter.
      wakeCandidates.push({
        id: idRes.value,
        kind: kindRes.value,
        recipient,
      });
    }

    const totalUnread = Math.min(MAX_COUNT, latestServerUnread + countedEvents);
    const digests: DigestResult[] = [];
    if (digestCandidates.length > 0 && this.summarize) {
      const digestResult = await runLocalDigestAsync({
        items: digestCandidates,
        summarize: this.summarize,
        maxDigestLength: this.config.maxDigestLength,
      });
      digests.push(digestResult);
      if (this.onDigest) {
        await this.onDigest(
          digestResult,
          digestCandidates
            .filter((d) => scrubId(d.id).accepted && scrubKind(d.kind).accepted)
            .map((d) => ({ id: d.id as string, kind: d.kind as string }))
        );
      }
    }

    const wakes: WakeDelivery[] = [];
    const decisions: LimiterDecision[] = [];
    let heldCount = 0;
    let heldOverflowCount = 0;

    for (const occ of wakeCandidates) {
      const dec = this.limiter.onEvent(occ);
      decisions.push(dec);
      if (dec.decision === "wake") {
        const delivery = await this.emitWakeFromDecision(dec, totalUnread);
        wakes.push(delivery);
      } else if (dec.decision === "hold") {
        heldCount = dec.heldIds;
        heldOverflowCount = dec.heldOverflowCount;
      }
    }

    return {
      pollsMade,
      catchUpPolls,
      cursor: this.cursor,
      nextPollMs: clampNextPollMs(nextPollMs, maxPollMs),
      badCursors,
      classifyErrors,
      wakes,
      digests,
      heldCount,
      heldOverflowCount,
      unreadCount: totalUnread,
      decisions,
    };
  }

  /**
   * Flush pending coalesced events from the rate limiter.
   */
  async flush(unreadCount: number = 0): Promise<WakeDelivery | null> {
    const dec = this.limiter.flush();
    if (dec.decision === "wake") {
      return await this.emitWakeFromDecision(dec, unreadCount);
    }
    return null;
  }
}
