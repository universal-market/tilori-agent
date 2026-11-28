import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ALLOW } from './host-text-allowlist.ts';

// UNI-1178 S1a: no host-named string outside src/hosts/claude/ except the
// allow-list. How it scans: each src/**/*.ts file is parsed with the TypeScript
// compiler (already a devDependency) and only string literals and template
// literal parts are checked, so comments and identifiers never count. The
// checked text is the literal's value after escapes. A hit is a literal that
// contains one of PATTERNS.
const SRC = join(import.meta.dir, '..', 'src');
const PATTERNS: Array<[string, RegExp]> = [
  ['claude', /claude/i],
  ['codex', /codex/i],
  // The /mcp slash command, not a URL path such as /mcp/v1 or /mcp/tilori/v1.
  ['/mcp', /\/mcp(?![\w/-])/],
  ['/tilori:', /\/tilori:/],
  ['/universal-market:', /\/universal-market:/],
  ['mcp__plugin_', /mcp__plugin_/],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

interface Hit {
  file: string;
  line: number;
  literal: string;
  pattern: string;
}

function scan(path: string): Hit[] {
  const file = relative(SRC, path).split('\\').join('/');
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (n: ts.Node) => {
    // Import and export specifiers are module paths (the accessor imports the table), not text.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      for (const [name, re] of PATTERNS)
        if (re.test(n.text)) hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, literal: n.text, pattern: name });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

const outside = files(SRC).filter((f) => !relative(SRC, f).startsWith(join('hosts', 'claude') + '/'));
const allHits = outside.flatMap(scan);
const listed = (h: Hit) => ALLOW.some((a) => a.file === h.file && a.literal === h.literal);

describe('host names stay in src/hosts/claude/', () => {
  test('the scanner sees the patterns it is looking for (self-check)', () => {
    const tmp = ts.createSourceFile('x.ts', "// claude in a comment\nconst a = 'run /mcp now'; const b = `/mcp/v1`; const c = `x ${1} /tilori:y`;", ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateTail(n)) found.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(tmp);
    expect(found.filter((s) => PATTERNS.some(([, re]) => re.test(s)))).toEqual(['run /mcp now', ' /tilori:y']);
  });

  test('no host-named string literal outside src/hosts/claude/ except the allow-list', () => {
    const unlisted = allHits.filter((h) => !listed(h)).map((h) => `src/${h.file}:${h.line} [${h.pattern}] ${JSON.stringify(h.literal.slice(0, 100))}`);
    expect(unlisted).toEqual([]);
  });

  test('every allow-list entry still matches a literal (no stale entries) and has a reason', () => {
    const stale = ALLOW.filter((a) => !allHits.some((h) => h.file === a.file && h.literal === a.literal)).map((a) => `${a.file}: ${JSON.stringify(a.literal.slice(0, 100))}`);
    expect(stale).toEqual([]);
    for (const a of ALLOW) expect(a.reason.trim().length).toBeGreaterThan(10);
  });

  test('the allow-list has no duplicate entries', () => {
    const keys = ALLOW.map((a) => `${a.file}\0${a.literal}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
