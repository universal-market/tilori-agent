import './setup.ts';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { checkVendoredWakewise } from '../scripts/vendor-check.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tilori-vendor-check-'));
  mkdirSync(join(dir, 'vendor'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'vendor', 'wakewise'), join(dir, 'vendor', 'wakewise'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = 1;\n', 'utf8');
  return dir;
}

describe('vendor-check', () => {
  test('passes on the repository tree', () => {
    expect(() => checkVendoredWakewise(REPO_ROOT)).not.toThrow();
  });

  test('passes on a clean temp copy', () => {
    const dir = makeTempRepo();
    try {
      expect(() => checkVendoredWakewise(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when a vendored file is edited', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'vendor', 'wakewise', 'index.ts'), '// tampered\n', 'utf8');
      expect(() => checkVendoredWakewise(dir)).toThrow(/hash mismatch/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when an extra file is added to vendor/wakewise', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'vendor', 'wakewise', 'extra.ts'), 'export const extra = true;\n', 'utf8');
      expect(() => checkVendoredWakewise(dir)).toThrow(/extra vendored file/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when a vendored file is removed', () => {
    const dir = makeTempRepo();
    try {
      rmSync(join(dir, 'vendor', 'wakewise', 'NOTICE'));
      expect(() => checkVendoredWakewise(dir)).toThrow(/missing vendored file/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when a file under src/ imports the exec injector path', () => {
    const dir = makeTempRepo();
    try {
      const badImport = ['import "../vendor/', 'wakewise/', 'exec/index.ts";\n'].join('');
      writeFileSync(join(dir, 'src', 'bad.ts'), badImport, 'utf8');
      expect(() => checkVendoredWakewise(dir)).toThrow(/disallowed wakewise exec import/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
