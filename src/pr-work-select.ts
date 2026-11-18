/** Reviewer selection for PR work: a pure function with no I/O.
 *
 * Spec: merge-check section 3a point 5. Each reviewer is on our list for its
 * kind, is not the implementer, the opener, the client or another reviewer of
 * this run, and has a different owner from the implementer. Agents are
 * compared by their `agent` id, never by handle. */

export interface Agent {
  /** Market agent id. */
  agent: string;
  handle: string;
  /** Market account id. */
  owner: string;
}

export type ReviewKind = 'code' | 'security' | 'docs';

export const REVIEW_KINDS: readonly ReviewKind[] = ['code', 'security', 'docs'];

export interface SelectInput {
  kinds: readonly ReviewKind[];
  implementer: Agent;
  client: Agent;
  opener?: Agent;
  /** Candidates per kind, in preference order. */
  lists: Record<string, readonly Agent[]>;
}

export interface SelectPick {
  kind: string;
  agent: Agent;
}

export type SelectRule = 'no_list' | 'not_listed' | 'implementer' | 'client' | 'other_reviewer' | 'same_owner';

export type SelectResult =
  | { ok: true; picks: SelectPick[] }
  | { ok: false; rule: SelectRule; kind: string; detail: string };

/** Tie-break order for naming the most-excluding rule. `implementer` covers
 * the opener too (the spec excludes them the same way). */
const RULE_ORDER = ['implementer', 'client', 'other_reviewer', 'same_owner'] as const;

const KNOWN = new Set<string>(REVIEW_KINDS);

const isKnownKind = (kind: string): kind is ReviewKind => KNOWN.has(kind);

/** Selects one reviewer per kind, in `kinds` order. Deterministic, never
 * mutates `input`, and makes no I/O. */
export function selectReviewers(input: SelectInput): SelectResult {
  const kinds = Array.isArray(input.kinds) ? input.kinds : [];
  if (kinds.length === 0) return { ok: false, rule: 'no_list', kind: '', detail: 'no kinds' };

  const lists = input.lists ?? {};
  const picks: SelectPick[] = [];
  const picked = new Set<string>();

  for (const kind of kinds) {
    if (!isKnownKind(kind)) return { ok: false, rule: 'not_listed', kind: String(kind), detail: `unknown kind "${String(kind)}"` };

    const candidates = lists[kind];
    if (!Array.isArray(candidates) || candidates.length === 0)
      return { ok: false, rule: 'no_list', kind, detail: `no reviewer list for ${kind}` };

    let pick: Agent | undefined;
    const handles: Record<(typeof RULE_ORDER)[number], string[]> = {
      implementer: [],
      client: [],
      other_reviewer: [],
      same_owner: [],
    };

    for (const candidate of candidates) {
      if (!candidate || candidate.agent === input.implementer.agent) {
        handles.implementer.push(candidate?.handle ?? '');
        continue;
      }
      if (input.opener && candidate.agent === input.opener.agent) {
        handles.implementer.push(candidate.handle);
        continue;
      }
      if (candidate.agent === input.client.agent) {
        handles.client.push(candidate.handle);
        continue;
      }
      if (picked.has(candidate.agent)) {
        handles.other_reviewer.push(candidate.handle);
        continue;
      }
      if (candidate.owner === input.implementer.owner) {
        handles.same_owner.push(candidate.handle);
        continue;
      }
      pick = candidate;
      break;
    }

    if (!pick) {
      // Name the rule that excluded the most candidates; ties go to the
      // first rule in RULE_ORDER. Every candidate matched at least one rule.
      let rule: (typeof RULE_ORDER)[number] = RULE_ORDER[0];
      let most = -1;
      for (const name of RULE_ORDER) {
        const count = handles[name].length;
        if (count > most) {
          most = count;
          rule = name;
        }
      }
      const detail = RULE_ORDER.map((name) => `${name}: ${handles[name].length ? handles[name].join(', ') : '-'}`).join('; ');
      return { ok: false, rule, kind, detail: `${kind}: ${detail}` };
    }

    picks.push({ kind, agent: pick });
    picked.add(pick.agent);
  }

  return { ok: true, picks };
}
