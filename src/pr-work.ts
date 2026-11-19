import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectReviewers, type Agent, type ReviewKind } from './pr-work-select.ts';

const WORKFLOWS_GLOB = '.github/workflows/**';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_ACCEPTANCE = 'All required CI passes at the reviewed head and every linked review approves it.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrWorkAgents {
  client: Agent;
  implementer: Agent;
  opener?: Agent;
  lists: Record<string, Agent[]>;
}

export interface PrWorkListingOptions {
  repo: string;
  pr: string;
  docsOnly?: boolean;
  defaultsPath?: string;
  repoDir?: string;
  agents: PrWorkAgents;
  acceptance?: string;
}

export interface PrWorkProposalOptions extends PrWorkListingOptions {
  txs?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, name: string, repo: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`pr-work listing: "${name}" must be an array of strings for ${repo}.`);
  return value;
}

function checkListLimits(items: string[], name: string): void {
  if (items.length > 16) throw new Error(`pr-work listing: ${name} has more than 16 items.`);
  if (items.some((item) => Buffer.byteLength(item, 'utf8') > 256))
    throw new Error(`pr-work listing: ${name} items must be at most 256 UTF-8 bytes.`);
}

function parseAgent(value: unknown): Agent {
  const handle = isRecord(value) && typeof value.handle === 'string' && value.handle ? value.handle : '?';
  if (
    !isRecord(value) ||
    typeof value.agent !== 'string' ||
    !value.agent ||
    typeof value.handle !== 'string' ||
    !value.handle ||
    typeof value.owner !== 'string' ||
    !value.owner
  )
    throw new Error(`pr-work listing: agent "${handle}" needs a non-empty agent, handle and owner`);
  return { agent: value.agent, handle: value.handle, owner: value.owner };
}

/** Validates the local agents file without retaining unknown extra keys. */
export function parseAgents(value: unknown): PrWorkAgents {
  if (!isRecord(value)) throw new Error('pr-work listing: agents must be a JSON object.');
  if (value.client === undefined || value.implementer === undefined)
    throw new Error('pr-work listing: agents needs client and implementer.');
  if (!isRecord(value.lists)) throw new Error('pr-work listing: lists must be an object whose values are arrays of agents.');

  const lists: Record<string, Agent[]> = {};
  for (const [kind, candidates] of Object.entries(value.lists)) {
    if (!Array.isArray(candidates)) throw new Error('pr-work listing: lists must be an object whose values are arrays of agents.');
    lists[kind] = candidates.map(parseAgent);
  }

  return {
    client: parseAgent(value.client),
    implementer: parseAgent(value.implementer),
    ...(value.opener === undefined ? {} : { opener: parseAgent(value.opener) }),
    lists,
  };
}

/** Builds a Market create_listing payload locally. This reads one defaults
 * file; it does not read agent configuration or make any Market call. */
export function buildPrWorkListing(options: PrWorkListingOptions) {
  if (!REPO.test(options.repo)) throw new Error('pr-work listing: --repo must match owner/repo.');
  if (!/^[1-9][0-9]*$/.test(options.pr) || !Number.isSafeInteger(Number(options.pr)))
    throw new Error('pr-work listing: --pr must be a positive integer.');

  const path = options.defaultsPath ?? join(options.repoDir ?? process.cwd(), 'scripts', 'merge-check-defaults.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`pr-work listing: could not read defaults file ${path}.`);
  }

  let defaults: unknown;
  try {
    defaults = JSON.parse(text);
  } catch {
    throw new Error(`pr-work listing: defaults file is not valid JSON: ${path}.`);
  }
  const entry = isRecord(defaults) ? defaults[options.repo] : undefined;
  if (!isRecord(entry)) throw new Error(`pr-work listing: no defaults entry for ${options.repo} in ${path}.`);

  const workflows = stringArray(entry.workflows, 'workflows', options.repo);
  const protectedPaths = stringArray(entry.protected_paths, 'protected_paths', options.repo);
  if (entry.base !== undefined && (typeof entry.base !== 'string' || !entry.base))
    throw new Error(`pr-work listing: "base" must be a non-empty string for ${options.repo}.`);
  const base = typeof entry.base === 'string' ? entry.base : 'main';
  const confirmPaths = [...new Set([WORKFLOWS_GLOB, ...protectedPaths])];
  checkListLimits(workflows, 'required_ci');
  checkListLimits(confirmPaths, 'confirm_paths');
  const acceptance = options.acceptance ?? DEFAULT_ACCEPTANCE;
  if (Buffer.byteLength(acceptance, 'utf8') > 4096)
    throw new Error('pr-work listing: acceptance must be at most 4096 UTF-8 bytes.');

  const kinds: ReviewKind[] = options.docsOnly ? ['docs'] : ['code', 'security'];
  const { client, implementer, opener, lists } = options.agents;
  const selected = selectReviewers({ kinds, implementer, client, opener, lists });
  if (!selected.ok)
    throw new Error(`pr-work listing: no reviewer for ${selected.kind}: ${selected.rule}: ${selected.detail}`);

  const kindInputs = Object.fromEntries(kinds.map((kind, index) => [`kind_${index + 1}`, kind]));
  return {
    listing: {
      kind: 'request',
      title: `PR work: ${options.repo}#${options.pr}`,
      description: `Review of ${options.repo}#${options.pr} under the pinned pr-work terms.`,
      contract_template_id: `universal-market/pr-work-r${kinds.length}`,
      contract_template_version: '2.0.0',
      contract_inputs: {
        client: { principal: `um:agent:${client.agent}` },
        repo: options.repo,
        acceptance,
        base,
        ...kindInputs,
        required_ci: workflows,
        confirm_paths: confirmPaths,
        objections: 'block',
        publish_terms: true,
        review_owner: 'client',
      },
    },
    reviewers: selected.picks.map((pick) => ({ kind: pick.kind, agent: pick.agent.agent, handle: pick.agent.handle })),
  };
}

/** Validates exactly one transaction UUID per selected review kind. */
export function parseTxs(value: unknown, kinds: readonly string[]): Record<string, string> {
  if (!isRecord(value)) throw new Error('pr-work propose: txs must be a JSON object.');
  const expected = new Set(kinds);
  for (const kind of kinds)
    if (!Object.hasOwn(value, kind)) throw new Error(`pr-work propose: txs is missing the "${kind}" transaction.`);
  for (const kind of Object.keys(value))
    if (!expected.has(kind)) throw new Error(`pr-work propose: txs has an unexpected "${kind}" entry.`);
  for (const kind of kinds) {
    const transaction = value[kind];
    if (typeof transaction !== 'string' || !UUID.test(transaction))
      throw new Error(`pr-work propose: txs entry for "${kind}" must be a transaction UUID.`);
  }
  return Object.fromEntries(kinds.map((kind) => [kind, value[kind] as string]));
}

/** Builds review agreement proposals and, once their transactions exist, the
 * parent pr-work proposal locally. Runtime fields are deliberately left out. */
export function buildPrWorkProposal(options: PrWorkProposalOptions) {
  const { listing, reviewers } = buildPrWorkListing(options);
  const { client, implementer } = options.agents;
  const principal = (agent: string) => ({ principal: `um:agent:${agent}` });
  const reviews = reviewers.map(({ kind, agent, handle }) => ({
    kind,
    reviewer: { agent, handle },
    proposal: {
      contract_template_id: 'universal-market/pr-review',
      contract_template_version: '1.0.0',
      contract_inputs: {
        client: principal(client.agent),
        implementer: principal(implementer.agent),
        reviewer: principal(agent),
        repo: listing.contract_inputs.repo,
        kind,
        acceptance: listing.contract_inputs.acceptance,
        publish_terms: true,
      },
    },
  }));
  if (options.txs === undefined) return { reviews, parent: null };

  const kinds = reviewers.map((reviewer) => reviewer.kind);
  const txs = parseTxs(options.txs, kinds);
  const reviewTransactions = Object.fromEntries(kinds.map((kind, index) => [`review_tx_${index + 1}`, { transaction: txs[kind] }]));
  return {
    reviews,
    parent: {
      contract_template_id: listing.contract_template_id,
      contract_template_version: '2.0.0',
      contract_inputs: {
        ...listing.contract_inputs,
        implementer: principal(implementer.agent),
        ...reviewTransactions,
      },
    },
  };
}
