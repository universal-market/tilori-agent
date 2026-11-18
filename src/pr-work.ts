import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Contract field names are provisional; keep them together while the
 * template is finalised. */
export const PR_WORK_FIELDS = {
  kinds: 'kinds',
  terms: 'terms',
  base: 'base',
  requiredCi: 'required_ci',
  confirmPaths: 'confirm_paths',
  objections: 'objections',
  publishTerms: 'publish_terms',
  end: 'end',
  reviewAt: 'review_at',
} as const;

const WORKFLOWS_GLOB = '.github/workflows/**';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PrWorkRequestOptions {
  repo: string;
  pr: string;
  docsOnly?: boolean;
  defaultsPath?: string;
  repoDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, name: string, repo: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`pr-work request: "${name}" must be an array of strings for ${repo}.`);
  return value;
}

/** Builds the PR-work contract terms locally. This reads one defaults file;
 * it does not read agent configuration or make any Market call. */
export function buildPrWorkRequest(options: PrWorkRequestOptions) {
  if (!REPO.test(options.repo)) throw new Error('pr-work request: --repo must match owner/repo.');
  if (!/^[1-9][0-9]*$/.test(options.pr) || !Number.isSafeInteger(Number(options.pr)))
    throw new Error('pr-work request: --pr must be a positive integer.');

  const path = options.defaultsPath ?? join(options.repoDir ?? process.cwd(), 'scripts', 'merge-check-defaults.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`pr-work request: could not read defaults file ${path}.`);
  }

  let defaults: unknown;
  try {
    defaults = JSON.parse(text);
  } catch {
    throw new Error(`pr-work request: defaults file is not valid JSON: ${path}.`);
  }
  const entry = isRecord(defaults) ? defaults[options.repo] : undefined;
  if (!isRecord(entry)) throw new Error(`pr-work request: no defaults entry for ${options.repo} in ${path}.`);

  const workflows = stringArray(entry.workflows, 'workflows', options.repo);
  const protectedPaths = stringArray(entry.protected_paths, 'protected_paths', options.repo);
  if (entry.base !== undefined && (typeof entry.base !== 'string' || !entry.base))
    throw new Error(`pr-work request: "base" must be a non-empty string for ${options.repo}.`);
  const base = typeof entry.base === 'string' ? entry.base : 'main';
  const confirmPaths = [...new Set([WORKFLOWS_GLOB, ...protectedPaths])];

  return {
    [PR_WORK_FIELDS.kinds]: options.docsOnly ? ['docs'] : ['code', 'security'],
    [PR_WORK_FIELDS.terms]: {
      [PR_WORK_FIELDS.base]: base,
      [PR_WORK_FIELDS.requiredCi]: workflows,
      [PR_WORK_FIELDS.confirmPaths]: confirmPaths,
      [PR_WORK_FIELDS.objections]: 'block',
      [PR_WORK_FIELDS.publishTerms]: true,
      [PR_WORK_FIELDS.end]: 'merge',
      [PR_WORK_FIELDS.reviewAt]: 'head',
    },
  };
}
