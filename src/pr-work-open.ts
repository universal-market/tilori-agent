import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PrWorkRole = 'implementer' | 'reviewer';

export interface PrWorkOpenOptions {
  building: string;
  txn: string;
  bodyPath?: string;
}

export interface PrWorkTakeOptions {
  role: string;
  listing: string;
  txn?: string;
}

export type PrWorkTakeStep =
  | { tool: 'respond_to_listing'; args: { listing_id: string } }
  | { tool: 'join_transaction'; args: { transaction_id: string } }
  | { tool: 'tilori.create_post'; note: 'post the full transaction id in the review thread' }
  | { tool: 'accept_contract'; note: 'after the proposer posts the contract id' };

/** Builds the PR body header (`Building:` and `Market:`) and optionally prepends
 * it to an existing PR body file locally without any Market or network calls. */
export function buildPrWorkOpen(options: PrWorkOpenOptions): { header: string; body?: string } {
  if (!UUID.test(options.building)) throw new Error('pr-work open: --building must be a UUID.');
  if (!UUID.test(options.txn)) throw new Error('pr-work open: --txn must be a UUID.');

  const buildingLine = `Building: ${options.building}`;
  const marketLine = `Market: ${options.txn}`;
  const header = `${buildingLine}\n${marketLine}\n`;
  if (options.bodyPath === undefined) return { header };

  let raw: string;
  try {
    raw = readFileSync(options.bodyPath, 'utf8');
  } catch {
    throw new Error(`pr-work open: could not read body file ${options.bodyPath}.`);
  }

  const lines = raw.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let marketCount = 0;
  for (const line of lines) {
    if (!line.startsWith('Market:')) continue;
    if (line !== marketLine) throw new Error('pr-work open: body already has a different Market: line.');
    marketCount++;
  }
  if (marketCount > 1) throw new Error('pr-work open: body has more than one Market: line.');
  if (lines.length > 0 && lines[0].startsWith('Building:') && lines[0] !== buildingLine)
    throw new Error('pr-work open: body starts with a different Building: line.');

  const remaining = lines.filter((line) => line !== buildingLine && line !== marketLine);
  while (remaining.length > 0 && remaining[0] === '') remaining.shift();
  const body = remaining.length > 0 ? `${header}\n${remaining.join('\n')}` : header;
  return { header, body };
}

/** Builds the ordered Market/Tilori MCP tool steps for an implementer or
 * reviewer taking pr-work, locally without any Market or network calls. */
export function buildPrWorkTake(options: PrWorkTakeOptions): { role: PrWorkRole; steps: PrWorkTakeStep[] } {
  if (options.role !== 'implementer' && options.role !== 'reviewer')
    throw new Error('pr-work take: --role must be implementer or reviewer.');
  if (!UUID.test(options.listing)) throw new Error('pr-work take: --listing must be a UUID.');
  if (options.txn !== undefined && !UUID.test(options.txn)) throw new Error('pr-work take: --txn must be a UUID.');

  const firstStep: PrWorkTakeStep =
    options.txn !== undefined
      ? { tool: 'join_transaction', args: { transaction_id: options.txn } }
      : { tool: 'respond_to_listing', args: { listing_id: options.listing } };

  return {
    role: options.role,
    steps: [
      firstStep,
      { tool: 'tilori.create_post', note: 'post the full transaction id in the review thread' },
      { tool: 'accept_contract', note: 'after the proposer posts the contract id' },
    ],
  };
}
