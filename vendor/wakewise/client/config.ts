// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLevel } from "./policy.ts";
import type { Level, PolicyRule } from "./policy.ts";
import { DEFAULT_LIMITS } from "./limiter.ts";
import type { LimiterLimits } from "./limiter.ts";
import {
  DEFAULT_MAX_DIGEST_LENGTH,
  DEFAULT_MAX_LINE_LENGTH,
  parseJsonStrict,
  scrubId,
  scrubKind,
} from "./line.ts";
import { DEFAULT_MAX_POLL_MS } from "./cursor.ts";

const ALLOWED_LEVELS_TEXT = "wake, digest, count, mute";
export const MAX_CONFIG_FILE_BYTES = 4096;
export const STARTER_CONFIG_JSON =
  '{\n  "levels": { "mention": "wake", "reply": "digest" }\n}\n';
const RELATIVE_CONFIG_PATH_ERROR =
  'configPath must be an absolute path (auto-load from the current directory is forbidden). Try: wakewise init $PWD/wakewise.json, or run "wakewise init" to write ~/.config/wakewise/wakewise.json';
const GLOB_PATTERN_RE = /^[a-z0-9_.*?]{1,128}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SECRET_KEY_RE =
  /^(?:.*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential|private_key).*)$/i;

const TOP_LEVEL_KEYS = new Set([
  "endpoint",
  "selfId",
  "defaultLevel",
  "rules",
  "levels",
  "directLane",
  "directKinds",
  "alwaysWake",
  "kindPriority",
  "limits",
  "cursorPath",
  "maxPollMs",
  "maxLineLength",
  "maxDigestLength",
  "exec",
]);

const LIMITS_KEYS = new Set([
  "wakesPerHour",
  "directWakesPerHour",
  "alwaysWakePerHour",
  "coalesceSeconds",
  "pauseSeconds",
  "heldQueueMaxIds",
]);

const EXEC_KEYS = new Set(["argv", "envAllowlist", "timeoutMs", "maxOutputBytes"]);

export interface ExecInjectorConfig {
  readonly argv: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface WakewiseConfig {
  readonly endpoint?: string;
  readonly selfId?: string;
  readonly defaultLevel: Level;
  readonly rules: readonly PolicyRule[];
  readonly directLane: boolean;
  readonly directKinds: readonly string[];
  readonly alwaysWake: readonly string[];
  readonly kindPriority: readonly string[];
  readonly limits: Readonly<LimiterLimits>;
  readonly cursorPath?: string;
  readonly maxPollMs: number;
  readonly maxLineLength: number;
  readonly maxDigestLength: number;
  readonly exec?: ExecInjectorConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigSecurityError";
  }
}

function assertNotSecretKey(fullKey: string, leafKey: string): void {
  if (SECRET_KEY_RE.test(leafKey)) {
    throw new ConfigError(`${fullKey}: secrets are not allowed in config`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBadValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return typeof value;
}

function parseLevelValue(key: string, value: unknown): Level {
  if (typeof value === "string" && isLevel(value)) {
    return value;
  }
  throw new ConfigError(
    `${key}: ${formatBadValue(value)} is not one of ${ALLOWED_LEVELS_TEXT}`
  );
}

function parseIntRange(
  key: string,
  value: unknown,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${key}: ${formatBadValue(value)} must be an integer between ${min} and ${max}`
    );
  }
  return value;
}

function parseGlob(key: string, value: unknown): string {
  if (typeof value !== "string" || !GLOB_PATTERN_RE.test(value)) {
    throw new ConfigError(
      `${key}: must be a glob pattern of 1 to 128 lowercase ASCII letters, digits, '_', '.', '*', or '?'`
    );
  }
  return value;
}

function parseGlobArray(key: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${key}: must be a list of glob patterns`);
  }
  return value.map((item, idx) => parseGlob(`${key}[${idx}]`, item));
}

function parseEndpoint(key: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      `${key}: must be an https:// URL (or http:// for localhost, 127.0.0.1, [::1])`
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `${key}: must be a valid https:// URL (or http:// for localhost, 127.0.0.1, [::1])`
    );
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError(`${key}: credentials are not allowed in endpoint URL`);
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";

  if (parsed.protocol === "https:") {
    return value;
  }
  if (parsed.protocol === "http:" && isLoopback) {
    return value;
  }
  throw new ConfigError(
    `${key}: must use https:// (or http:// for localhost, 127.0.0.1, [::1])`
  );
}

function parseExecConfig(raw: unknown): ExecInjectorConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("exec: must be an object");
  }
  for (const k of Object.keys(raw)) {
    assertNotSecretKey(`exec.${k}`, k);
    if (!EXEC_KEYS.has(k)) {
      throw new ConfigError(
        `exec.${k}: unknown key (allowed: argv, envAllowlist, timeoutMs, maxOutputBytes)`
      );
    }
  }
  if (!Array.isArray(raw.argv) || raw.argv.length === 0) {
    throw new ConfigError("exec.argv: must be a non-empty list of strings");
  }
  const argv: string[] = [];
  for (let i = 0; i < raw.argv.length; i += 1) {
    const item = raw.argv[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new ConfigError(`exec.argv[${i}]: must be a non-empty string`);
    }
    argv.push(item);
  }
  if (!argv[0].startsWith("/")) {
    throw new ConfigError("exec.argv[0]: must be an absolute path starting with '/'");
  }

  let envAllowlist: string[] = [];
  if (raw.envAllowlist !== undefined) {
    if (!Array.isArray(raw.envAllowlist)) {
      throw new ConfigError("exec.envAllowlist: must be a list of environment variable names");
    }
    envAllowlist = raw.envAllowlist.map((item, idx) => {
      if (typeof item !== "string" || !ENV_NAME_RE.test(item)) {
        throw new ConfigError(
          `exec.envAllowlist[${idx}]: must be a valid environment variable name`
        );
      }
      return item;
    });
  }

  const timeoutMs =
    raw.timeoutMs === undefined
      ? 5000
      : parseIntRange("exec.timeoutMs", raw.timeoutMs, 100, 60000);
  const maxOutputBytes =
    raw.maxOutputBytes === undefined
      ? 4096
      : parseIntRange("exec.maxOutputBytes", raw.maxOutputBytes, 0, 65536);

  return { argv, envAllowlist, timeoutMs, maxOutputBytes };
}

/**
 * Parse and validate Wakewise configuration.
 * Zero-config defaults: defaultLevel="mute", wakesPerHour=12, directLane=true.
 */
export function parseConfig(raw?: unknown): WakewiseConfig {
  if (raw === undefined || raw === null) {
    return {
      defaultLevel: "mute",
      rules: [],
      directLane: true,
      directKinds: ["message.direct", "mention.direct"],
      alwaysWake: [],
      kindPriority: [],
      limits: { ...DEFAULT_LIMITS },
      maxPollMs: DEFAULT_MAX_POLL_MS,
      maxLineLength: DEFAULT_MAX_LINE_LENGTH,
      maxDigestLength: DEFAULT_MAX_DIGEST_LENGTH,
    };
  }

  if (!isPlainObject(raw)) {
    throw new ConfigError("config: root must be a JSON object");
  }

  for (const key of Object.keys(raw)) {
    assertNotSecretKey(key, key);
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(
        `${key}: unknown config key (allowed: ${Array.from(TOP_LEVEL_KEYS).join(", ")})`
      );
    }
  }

  const defaultLevel: Level =
    raw.defaultLevel === undefined
      ? "mute"
      : parseLevelValue("defaultLevel", raw.defaultLevel);

  const rules: PolicyRule[] = [];

  if (raw.levels !== undefined) {
    if (!isPlainObject(raw.levels)) {
      throw new ConfigError("levels: must be an object mapping glob patterns to levels");
    }
    for (const [pattern, lvl] of Object.entries(raw.levels)) {
      assertNotSecretKey(`levels.${pattern}`, pattern);
      parseGlob(`levels.${pattern}`, pattern);
      const parsedLevel = parseLevelValue(`levels.${pattern}`, lvl);
      rules.push({ pattern, level: parsedLevel });
    }
  }

  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      throw new ConfigError("rules: must be a list of { pattern, level } objects");
    }
    for (let i = 0; i < raw.rules.length; i += 1) {
      const entry = raw.rules[i];
      if (!isPlainObject(entry)) {
        throw new ConfigError(`rules[${i}]: must be an object with pattern and level`);
      }
      for (const k of Object.keys(entry)) {
        assertNotSecretKey(`rules[${i}].${k}`, k);
        if (k !== "pattern" && k !== "level") {
          throw new ConfigError(`rules[${i}].${k}: unknown key (allowed: pattern, level)`);
        }
      }
      const pattern = parseGlob(`rules[${i}].pattern`, entry.pattern);
      const level = parseLevelValue(`rules[${i}].level`, entry.level);
      rules.push({ pattern, level });
    }
  }

  let directLane = true;
  if (raw.directLane !== undefined) {
    if (typeof raw.directLane !== "boolean") {
      throw new ConfigError("directLane: must be true or false");
    }
    directLane = raw.directLane;
  }

  const directKinds =
    raw.directKinds === undefined
      ? ["message.direct", "mention.direct"]
      : parseGlobArray("directKinds", raw.directKinds);

  const alwaysWake =
    raw.alwaysWake === undefined
      ? []
      : parseGlobArray("alwaysWake", raw.alwaysWake);

  let kindPriority: string[] = [];
  if (raw.kindPriority !== undefined) {
    if (!Array.isArray(raw.kindPriority)) {
      throw new ConfigError("kindPriority: must be a list of event kinds");
    }
    kindPriority = raw.kindPriority.map((item, idx) => {
      const res = scrubKind(item);
      if (!res.accepted) {
        throw new ConfigError(
          `kindPriority[${idx}]: ${formatBadValue(item)} is not a valid event kind`
        );
      }
      return res.value;
    });
  }

  const limits: LimiterLimits = { ...DEFAULT_LIMITS };
  if (raw.limits !== undefined) {
    if (!isPlainObject(raw.limits)) {
      throw new ConfigError("limits: must be an object");
    }
    for (const k of Object.keys(raw.limits)) {
      assertNotSecretKey(`limits.${k}`, k);
      if (!LIMITS_KEYS.has(k)) {
        throw new ConfigError(
          `limits.${k}: unknown key (allowed: ${Array.from(LIMITS_KEYS).join(", ")})`
        );
      }
    }
    if (raw.limits.wakesPerHour !== undefined) {
      limits.wakesPerHour = parseIntRange(
        "limits.wakesPerHour",
        raw.limits.wakesPerHour,
        0,
        999999
      );
    }
    if (raw.limits.directWakesPerHour !== undefined) {
      limits.directWakesPerHour = parseIntRange(
        "limits.directWakesPerHour",
        raw.limits.directWakesPerHour,
        0,
        999999
      );
    }
    if (raw.limits.alwaysWakePerHour !== undefined) {
      limits.alwaysWakePerHour = parseIntRange(
        "limits.alwaysWakePerHour",
        raw.limits.alwaysWakePerHour,
        0,
        999999
      );
    }
    if (raw.limits.coalesceSeconds !== undefined) {
      limits.coalesceSeconds = parseIntRange(
        "limits.coalesceSeconds",
        raw.limits.coalesceSeconds,
        0,
        3600
      );
    }
    if (raw.limits.pauseSeconds !== undefined) {
      limits.pauseSeconds = parseIntRange(
        "limits.pauseSeconds",
        raw.limits.pauseSeconds,
        0,
        3600
      );
    }
    if (raw.limits.heldQueueMaxIds !== undefined) {
      limits.heldQueueMaxIds = parseIntRange(
        "limits.heldQueueMaxIds",
        raw.limits.heldQueueMaxIds,
        1,
        1024
      );
    }
  }

  let endpoint: string | undefined;
  if (raw.endpoint !== undefined) {
    endpoint = parseEndpoint("endpoint", raw.endpoint);
  }

  let selfId: string | undefined;
  if (raw.selfId !== undefined) {
    const res = scrubId(raw.selfId);
    if (!res.accepted) {
      throw new ConfigError("selfId: must be a lowercase ASCII UUID");
    }
    selfId = res.value;
  }

  let cursorPath: string | undefined;
  if (raw.cursorPath !== undefined) {
    if (typeof raw.cursorPath !== "string" || !path.isAbsolute(raw.cursorPath)) {
      throw new ConfigError("cursorPath: must be an absolute path");
    }
    cursorPath = raw.cursorPath;
  }

  const maxPollMs =
    raw.maxPollMs === undefined
      ? DEFAULT_MAX_POLL_MS
      : parseIntRange("maxPollMs", raw.maxPollMs, 1000, 86400000);

  const maxLineLength =
    raw.maxLineLength === undefined
      ? DEFAULT_MAX_LINE_LENGTH
      : parseIntRange("maxLineLength", raw.maxLineLength, 64, 4096);

  const maxDigestLength =
    raw.maxDigestLength === undefined
      ? DEFAULT_MAX_DIGEST_LENGTH
      : parseIntRange("maxDigestLength", raw.maxDigestLength, 64, 16384);

  const exec = raw.exec === undefined ? undefined : parseExecConfig(raw.exec);

  return {
    endpoint,
    selfId,
    defaultLevel,
    rules,
    directLane,
    directKinds,
    alwaysWake,
    kindPriority,
    limits,
    cursorPath,
    maxPollMs,
    maxLineLength,
    maxDigestLength,
    exec,
  };
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
 * Load configuration from an explicit file path.
 * Opens with O_NOFOLLOW, fstats the open fd (checking owner and mode),
 * and reads at most 4096 bytes from that fd (no lstat-then-read race).
 */
export function loadConfigFile(filePath: string): WakewiseConfig {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new ConfigSecurityError(
      "configPath: explicit config path is required (auto-load from cwd is forbidden)"
    );
  }
  if (!path.isAbsolute(filePath)) {
    throw new ConfigSecurityError(RELATIVE_CONFIG_PATH_ERROR);
  }

  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);

  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ConfigSecurityError("configPath: refusing symlink");
    }
    throw err;
  }

  let content: string;
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      throw new ConfigSecurityError("configPath: must be a regular file");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new ConfigSecurityError(
        `configPath: refusing group-writable or world-writable config file ${filePath}; fix with: chmod go-w ${filePath}`
      );
    }
    if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
      throw new ConfigSecurityError(
        "configPath: refusing config file owned by another user"
      );
    }

    const { bytes, exceeded } = readBoundedFd(fd, MAX_CONFIG_FILE_BYTES);
    if (exceeded) {
      throw new ConfigSecurityError(
        `configPath: refusing config file exceeding ${MAX_CONFIG_FILE_BYTES} bytes`
      );
    }
    content = bytes.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonStrict(content);
  } catch {
    throw new ConfigError("config: file does not contain valid JSON");
  }
  return parseConfig(parsed);
}

function assertSafeConfigDir(dirPath: string): void {
  const dirFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);

  let dirFd: number;
  try {
    dirFd = fs.openSync(dirPath, dirFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ConfigSecurityError("configPath: refusing symlinked parent directory");
    }
    if (code === "ENOTDIR") {
      throw new ConfigSecurityError("configPath: parent path is not a directory");
    }
    throw err;
  }

  try {
    const stats = fs.fstatSync(dirFd);
    if (!stats.isDirectory()) {
      throw new ConfigSecurityError("configPath: parent path is not a directory");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new ConfigSecurityError(
        `configPath: refusing group-writable or world-writable parent directory ${dirPath}; fix with: chmod go-w ${dirPath}`
      );
    }
    if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
      throw new ConfigSecurityError(
        "configPath: refusing parent directory owned by another user"
      );
    }
  } finally {
    fs.closeSync(dirFd);
  }
}

function ensureUserConfigDir(dirPath: string): void {
  try {
    assertSafeConfigDir(dirPath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  fs.mkdirSync(dirPath, { mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
  assertSafeConfigDir(dirPath);
}

export function resolveDefaultConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    if (!path.isAbsolute(xdg)) {
      throw new ConfigSecurityError(
        "configPath: XDG_CONFIG_HOME must be an explicit absolute path"
      );
    }
    return path.join(xdg, "wakewise", "wakewise.json");
  }
  const home = os.homedir();
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new ConfigSecurityError("configPath: unable to resolve user config directory");
  }
  return path.join(home, ".config", "wakewise", "wakewise.json");
}

/**
 * Write a 3-line starter wakewise.json with mode 0600 using the same safe path
 * rules as loadConfigFile: explicit absolute path (or user-owned config dir),
 * O_NOFOLLOW, owner/mode checks on parent dir, and O_CREAT|O_EXCL refusal to
 * overwrite any existing file or symlink.
 */
export function initConfigFile(
  filePath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  let targetPath: string;
  if (filePath === undefined) {
    targetPath = resolveDefaultConfigPath(env);
    const configDir = path.dirname(targetPath);
    const baseDir = path.dirname(configDir);
    ensureUserConfigDir(baseDir);
    ensureUserConfigDir(configDir);
  } else {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new ConfigSecurityError(
        "configPath: explicit config path is required (auto-load from cwd is forbidden)"
      );
    }
    if (!path.isAbsolute(filePath)) {
      throw new ConfigSecurityError(RELATIVE_CONFIG_PATH_ERROR);
    }
    targetPath = filePath;
    assertSafeConfigDir(path.dirname(targetPath));
  }

  const fileFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  let fd: number;
  try {
    fd = fs.openSync(targetPath, fileFlags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ConfigError(
        `configPath: refusing to overwrite existing file: ${targetPath}`
      );
    }
    if (code === "ELOOP") {
      throw new ConfigSecurityError("configPath: refusing symlink");
    }
    throw err;
  }

  let written = false;
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      throw new ConfigSecurityError("configPath: must be a regular file");
    }
    if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
      throw new ConfigSecurityError(
        "configPath: refusing config file owned by another user"
      );
    }
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, STARTER_CONFIG_JSON, "utf8");
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }

  return targetPath;
}
