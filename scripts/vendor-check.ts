import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface VendorManifest {
  upstream: string;
  commit: string;
  subpath: string;
  files: Record<string, string>;
  tree_sha256: string;
  excluded: string[];
}

const CODE_EXT_RE = /\.(?:[cm]?[tj]s|[tj]sx)$/;
const IMPORT_SPEC_RE =
  /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'"\n]*?\bfrom\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const SKIP_DIRS = new Set(['node_modules', '.git', '.kit', 'vendor']);

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function walkVendor(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`vendored symlink is not allowed: ${relative(root, full)}`);
    }
    if (st.isDirectory()) {
      out.push(...walkVendor(full, root));
    } else if (st.isFile()) {
      out.push(relative(root, full).split(sep).join('/'));
    } else {
      throw new Error(`unexpected vendored entry type: ${relative(root, full)}`);
    }
  }
  return out;
}

function listFilesOutsideVendor(repoRoot: string): string[] {
  try {
    const raw = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0 && !p.startsWith('vendor/') && !p.startsWith('.kit/') && CODE_EXT_RE.test(p));
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          const rel = relative(repoRoot, join(dir, entry.name)).split(sep).join('/');
          if (CODE_EXT_RE.test(rel)) out.push(rel);
        }
      }
    };
    walk(repoRoot);
    return out;
  }
}

function validateManifest(raw: unknown): VendorManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('VENDOR.json must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.upstream !== 'wakewise') throw new Error('VENDOR.json: upstream must be "wakewise"');
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) {
    throw new Error('VENDOR.json: commit must be a 40-char lowercase hex sha');
  }
  if (typeof m.subpath !== 'string' || !m.subpath) {
    throw new Error('VENDOR.json: subpath must be a non-empty string');
  }
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) {
    throw new Error('VENDOR.json: files must be an object');
  }
  for (const [k, v] of Object.entries(m.files as Record<string, unknown>)) {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
      throw new Error(`VENDOR.json: invalid sha256 for ${k}`);
    }
  }
  if (typeof m.tree_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.tree_sha256)) {
    throw new Error('VENDOR.json: invalid tree_sha256');
  }
  if (!Array.isArray(m.excluded) || !m.excluded.every((x) => typeof x === 'string')) {
    throw new Error('VENDOR.json: excluded must be an array of strings');
  }
  return m as unknown as VendorManifest;
}

export function checkVendoredWakewise(repoRoot: string): void {
  const vendorDir = join(repoRoot, 'vendor', 'wakewise');
  const manifestPath = join(vendorDir, 'VENDOR.json');
  if (!existsSync(vendorDir)) throw new Error(`missing vendor directory: ${vendorDir}`);
  if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);

  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const diskFiles = walkVendor(vendorDir, vendorDir)
    .filter((p) => p !== 'VENDOR.json')
    .sort();

  for (const rel of diskFiles) {
    if (rel.toLowerCase().includes('exec')) {
      throw new Error(`vendored file path contains disallowed "exec": ${rel}`);
    }
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  const diskSet = new Set(diskFiles);
  const expectedSet = new Set(expectedFiles);

  for (const rel of diskFiles) {
    if (!expectedSet.has(rel)) {
      throw new Error(`extra vendored file not in VENDOR.json: ${rel}`);
    }
  }
  for (const rel of expectedFiles) {
    if (!diskSet.has(rel)) {
      throw new Error(`missing vendored file listed in VENDOR.json: ${rel}`);
    }
  }

  const lines: string[] = [];
  for (const rel of expectedFiles) {
    const actual = sha256(readFileSync(join(vendorDir, rel)));
    const expected = manifest.files[rel];
    if (actual !== expected) {
      throw new Error(`hash mismatch for ${rel}: expected ${expected}, got ${actual}`);
    }
    lines.push(`${rel}\0${actual}\n`);
  }

  const actualTree = sha256(lines.join(''));
  if (actualTree !== manifest.tree_sha256) {
    throw new Error(`tree_sha256 mismatch: expected ${manifest.tree_sha256}, got ${actualTree}`);
  }

  for (const rel of listFilesOutsideVendor(repoRoot)) {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    IMPORT_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPEC_RE.exec(text)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3] ?? '';
      const lower = spec.toLowerCase();
      if (lower.includes('wakewise') && lower.includes('exec')) {
        throw new Error(`disallowed wakewise exec import in ${rel}: ${spec}`);
      }
    }
  }
}

if (import.meta.main) {
  try {
    checkVendoredWakewise(resolve(import.meta.dir, '..'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
