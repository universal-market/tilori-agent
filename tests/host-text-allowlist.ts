// Literals outside src/hosts/claude/ that may still name the host (UNI-1178
// S1a). Each entry is one exact string literal (its text after escapes) in one
// file, with the reason it stays. tests/host-text-grep.test.ts fails on any
// other hit and on any entry that no longer matches, so the list only shrinks.
// None of these is prose: they are file names, env var names, argv and ids
// that behave rather than speak.
export interface AllowEntry {
  file: string;
  literal: string;
  reason: string;
}

export const ALLOW: AllowEntry[] = [
  { file: 'config.ts', literal: 'CLAUDE_PLUGIN_OPTION_TILORI_URL', reason: 'S1c: hook env var name, read as behaviour; moves with hook I/O' },
  { file: 'config.ts', literal: 'CLAUDE_PLUGIN_OPTION_MARKET_URL', reason: 'S1c: hook env var name, read as behaviour; moves with hook I/O' },
  { file: 'cli.ts', literal: 'claude', reason: 'S1c: the `claude` launcher command name in argv parsing and dispatch (behaviour, not prose)' },
];
