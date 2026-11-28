import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// UNI-1178 S1b: core files (src/**/*.ts outside src/hosts/) reach the Claude
// adapter only through its entry point, src/hosts/claude/index.ts (today
// through src/host.ts). Every import, export-from, dynamic import() and
// require() with a string specifier is resolved and checked. S1c switches on
// the full purity check; until then LEFTOVERS lists any core import of
// another file under src/hosts/claude/, each with its reason, and the stale
// check below makes the list shrink.
const SRC = join(import.meta.dir, '..', 'src');
const CLAUDE = join(SRC, 'hosts', 'claude');
const ENTRY = join(CLAUDE, 'index.ts');

interface Leftover {
  file: string; // relative to src/
  target: string; // relative to src/hosts/claude/
  reason: string;
}
export const LEFTOVERS: Leftover[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** String specifiers a source text imports, however it spells the import. */
export function specifiers(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]!)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) out.push((n.arguments[0] as ts.StringLiteralLike).text);
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return base;
}

const core = files(SRC).filter((f) => !relative(SRC, f).startsWith('hosts' + '/'));
const imports = core.flatMap((f) =>
  specifiers(f, readFileSync(f, 'utf8')).flatMap((spec) => {
    const to = resolveSpec(f, spec);
    return to && (to === CLAUDE || to.startsWith(CLAUDE + '/')) ? [{ file: relative(SRC, f), target: relative(CLAUDE, to) }] : [];
  }),
);
const isLeftover = (i: { file: string; target: string }) => LEFTOVERS.some((l) => l.file === i.file && l.target === i.target);

describe('core imports the claude adapter only through its entry point', () => {
  test('the scanner sees every spelling of an import (self-check)', () => {
    const text = "import a from './hosts/claude/text.ts'; export * from './hosts/claude/x.ts'; const b = await import('./hosts/claude/y.ts'); const c = require('./hosts/claude/z.ts'); type T = import('./hosts/claude/w.ts').W; import './hosts/claude/v.ts';";
    expect(specifiers('x.ts', text)).toEqual(['./hosts/claude/text.ts', './hosts/claude/x.ts', './hosts/claude/y.ts', './hosts/claude/z.ts', './hosts/claude/w.ts', './hosts/claude/v.ts']);
  });

  test('the entry point is imported (the scan is not vacuous)', () => {
    expect(imports.some((i) => i.target === 'index.ts')).toBe(true);
  });

  test('no core file imports another file under src/hosts/claude/', () => {
    const bad = imports.filter((i) => i.target !== relative(CLAUDE, ENTRY) && !isLeftover(i)).map((i) => `src/${i.file} imports src/hosts/claude/${i.target}`);
    expect(bad).toEqual([]);
  });

  test('every leftover still matches an import and has a reason', () => {
    const stale = LEFTOVERS.filter((l) => !imports.some((i) => i.file === l.file && i.target === l.target)).map((l) => `${l.file} -> ${l.target}`);
    expect(stale).toEqual([]);
    for (const l of LEFTOVERS) expect(l.reason.trim().length).toBeGreaterThan(10);
  });
});
