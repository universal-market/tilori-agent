// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import {
  DEFAULT_MAX_LINE_LENGTH,
  stripControlAndBidi,
} from "../line.ts";
import type { WakeLineResult } from "../line.ts";

export interface LineWriter {
  write(chunk: string): unknown;
}

export interface NotifyLinesOptions {
  readonly maxLineLength?: number;
  readonly stream?: LineWriter;
}

/**
 * Sanitize and emit a single wake line to stdout (or an injected writer).
 * Strips ANSI escape sequences, C0/C1 control characters (including CR/LF),
 * and Unicode bidi control characters, and caps length to maxLineLength.
 */
export function sanitizeNotifyLine(
  input: string | WakeLineResult,
  maxLineLength: number = DEFAULT_MAX_LINE_LENGTH
): string {
  if (!Number.isInteger(maxLineLength) || maxLineLength < 1) {
    throw new RangeError("maxLineLength: must be a positive integer");
  }
  const raw = typeof input === "string" ? input : input.line;
  let clean = stripControlAndBidi(raw);
  if (clean.length > maxLineLength) {
    clean = clean.slice(0, maxLineLength);
  }
  return clean;
}

export function notifyLines(
  input: string | WakeLineResult,
  options: NotifyLinesOptions = {}
): string {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const stream = options.stream ?? process.stdout;
  const clean = sanitizeNotifyLine(input, maxLineLength);
  stream.write(`${clean}\n`);
  return clean;
}
