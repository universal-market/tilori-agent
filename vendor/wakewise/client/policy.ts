// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

export type Level = "mute" | "count" | "digest" | "wake";
export type Lane = "normal" | "direct" | "alwaysWake";
export type PolicyAction = "wake" | "digest" | "drop";

export interface PolicyRule {
  readonly pattern: string;
  readonly level: Level;
}

export interface PolicyEvaluation {
  readonly matchedPattern: string | null;
  readonly level: Level;
}

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly lane: Lane;
  readonly reason: string;
  readonly level: Level;
  readonly matchedPattern: string | null;
}

export interface LanePolicyConfig extends LaneConfig {
  readonly rules: readonly PolicyRule[];
  readonly defaultLevel?: Level;
}

export interface LaneOccurrence {
  readonly kind: string;
  readonly recipient?: string | null;
}

export interface LaneConfig {
  readonly selfId?: string | null;
  readonly directLane?: boolean;
  readonly directKinds?: readonly string[];
  readonly alwaysWake?: readonly string[];
}

export const LEVELS: readonly Level[] = ["mute", "count", "digest", "wake"];

export const LEVEL_ORDER: Readonly<Record<Level, number>> = {
  mute: 0,
  count: 1,
  digest: 2,
  wake: 3,
};

export function isLevel(value: unknown): value is Level {
  return (
    value === "mute" ||
    value === "count" ||
    value === "digest" ||
    value === "wake"
  );
}

export function compareLevels(a: Level, b: Level): number {
  return LEVEL_ORDER[a] - LEVEL_ORDER[b];
}

export function sortLevels(levels: readonly Level[]): Level[] {
  return [...levels].sort(compareLevels);
}

export function minLevel(a: Level, b: Level): Level {
  return LEVEL_ORDER[a] <= LEVEL_ORDER[b] ? a : b;
}

/**
 * Glob-only matcher supporting '*' (zero or more chars) and '?' (single char).
 * All other characters (including regex metacharacters) are matched literally.
 */
export function matchGlob(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      pi += 1;
      ti += 1;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi;
      matchIdx = ti;
      pi += 1;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx += 1;
      ti = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === "*") {
    pi += 1;
  }

  return pi === pattern.length;
}

interface PatternScore {
  readonly isExact: boolean;
  readonly literalCount: number;
  readonly literalPrefixLen: number;
  readonly pattern: string;
}

function scorePattern(pattern: string): PatternScore {
  let literalCount = 0;
  let literalPrefixLen = -1;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" || ch === "?") {
      if (literalPrefixLen === -1) {
        literalPrefixLen = i;
      }
    } else if (ch !== ".") {
      literalCount += 1;
    }
  }

  const isExact = literalPrefixLen === -1;
  return {
    isExact,
    literalCount,
    literalPrefixLen: isExact ? pattern.length : literalPrefixLen,
    pattern,
  };
}

/**
 * Compare two glob patterns by specificity (negative means `a` wins over `b`).
 * 1. Exact match beats wildcard.
 * 2. Greater literal character count wins.
 * 3. Longer leading literal prefix wins.
 * 4. Ascending ASCII code-point lexicographic order wins.
 */
export function comparePatterns(a: string, b: string): number {
  const sa = scorePattern(a);
  const sb = scorePattern(b);

  if (sa.isExact !== sb.isExact) {
    return sa.isExact ? -1 : 1;
  }
  if (sa.literalCount !== sb.literalCount) {
    return sb.literalCount - sa.literalCount;
  }
  if (sa.literalPrefixLen !== sb.literalPrefixLen) {
    return sb.literalPrefixLen - sa.literalPrefixLen;
  }
  if (sa.pattern < sb.pattern) {
    return -1;
  }
  if (sa.pattern > sb.pattern) {
    return 1;
  }
  return 0;
}

export function evaluatePolicy(
  rules: readonly PolicyRule[],
  kind: string,
  defaultLevel: Level = "mute"
): PolicyEvaluation {
  let best: PolicyRule | null = null;

  for (const rule of rules) {
    if (!matchGlob(rule.pattern, kind)) {
      continue;
    }
    if (best === null || comparePatterns(rule.pattern, best.pattern) < 0) {
      best = rule;
    }
  }

  if (best === null) {
    return { matchedPattern: null, level: defaultLevel };
  }
  return { matchedPattern: best.pattern, level: best.level };
}

/**
 * Effective level = min(serverHint, clientLevel).
 * Missing, null, non-string, unknown, or mistyped hints are ignored ("no hint").
 */
export function effectiveLevel(clientLevel: Level, levelHint?: unknown): Level {
  if (typeof levelHint === "string" && isLevel(levelHint)) {
    return minLevel(clientLevel, levelHint);
  }
  return clientLevel;
}

/**
 * Client-owned lane selection from validated occurrence fields (`kind` and `recipient`) only.
 * Never reads `_meta`.
 * Precedence:
 * 1. `direct` when directLane is enabled, kind matches `directKinds`, and `recipient === selfId`.
 * 2. `alwaysWake` when kind matches `alwaysWake` (including fallback when direct recipient didn't match).
 * 3. `normal` otherwise.
 */
export function selectLane(
  occurrence: LaneOccurrence,
  config: LaneConfig
): Lane {
  const directEnabled = config.directLane !== false;
  const directKinds = config.directKinds ?? [];
  const alwaysWake = config.alwaysWake ?? [];

  if (
    directEnabled &&
    typeof config.selfId === "string" &&
    config.selfId.length > 0 &&
    typeof occurrence.recipient === "string" &&
    occurrence.recipient === config.selfId &&
    directKinds.some((pattern) => matchGlob(pattern, occurrence.kind))
  ) {
    return "direct";
  }

  if (alwaysWake.some((pattern) => matchGlob(pattern, occurrence.kind))) {
    return "alwaysWake";
  }

  return "normal";
}

/**
 * Evaluate policy rules, server `levelHint`, and client-owned lane selection,
 * returning a lane-aware decision `{ action, lane, reason, level, matchedPattern }`.
 */
export function evaluateLanePolicy(
  occurrence: LaneOccurrence & { readonly levelHint?: unknown },
  config: LanePolicyConfig
): PolicyDecision {
  const evalRes = evaluatePolicy(
    config.rules,
    occurrence.kind,
    config.defaultLevel ?? "mute"
  );
  const eff = effectiveLevel(evalRes.level, occurrence.levelHint);
  const lane = selectLane(occurrence, config);
  const action: PolicyAction =
    eff === "wake" ? "wake" : eff === "digest" ? "digest" : "drop";

  let reason: string;
  if (eff !== evalRes.level) {
    reason = "server_hint_clamped";
  } else if (evalRes.matchedPattern !== null) {
    reason = "matched_rule";
  } else {
    reason = "default_level";
  }

  return {
    action,
    lane,
    reason,
    level: eff,
    matchedPattern: evalRes.matchedPattern,
  };
}
