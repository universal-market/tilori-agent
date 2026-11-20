/** Reviewer selection for PR work: a pure function with no I/O.
 *
 * Spec: merge-check section 3a point 5. Each reviewer is on our list for its
 * kind, is not the implementer, the opener, the client or another reviewer of
 * this run, and is not on the same GitHub bot as the implementer, the opener
 * or another reviewer. The same owner is allowed (Don, 2026-11-20). Agents are
 * compared by their `agent` id, never by handle. The bot id is optional here
 * (the agents file may not list it): selection only skips a known match, and
 * merge-check, which refuses a missing id, is the gate. */

export interface Agent {
  /** Market agent id. */
  agent: string;
  handle: string;
  /** Market account id. */
  owner: string;
  /** GitHub user id of the bot this agent reviews or pushes as, when known. */
  github_user_id?: number;
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

export type SelectRule = 'no_list' | 'not_listed' | 'implementer' | 'client' | 'other_reviewer' | 'same_bot';

export type SelectResult =
  | { ok: true; picks: SelectPick[] }
  | { ok: false; rule: SelectRule; kind: string; detail: string };

/** Tie-break order for naming the most-excluding rule. `implementer` covers
 * the opener too (the spec excludes them the same way). */
const RULE_ORDER = ['implementer', 'client', 'other_reviewer', 'same_bot'] as const;

const KNOWN = new Set<string>(REVIEW_KINDS);

const isKnownKind = (kind: string): kind is ReviewKind => KNOWN.has(kind);

const hasIdentity = (value: Agent | undefined): value is Agent =>
  !!value && typeof value.agent === 'string' && !!value.agent && typeof value.owner === 'string' && !!value.owner;

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

    const actors: [string, Agent | undefined][] = [
      ['implementer', input.implementer],
      ['client', input.client],
      ['opener', input.opener],
    ];
    for (const [role, actor] of actors)
      if ((role !== 'opener' || actor !== undefined) && !hasIdentity(actor))
        return { ok: false, rule: 'not_listed', kind, detail: `${kind}: ${role} has an empty agent or owner` };

    const candidates = lists[kind];
    if (!Array.isArray(candidates) || candidates.length === 0)
      return { ok: false, rule: 'no_list', kind, detail: `no reviewer list for ${kind}` };
    for (const candidate of candidates)
      if (!hasIdentity(candidate))
        return { ok: false, rule: 'not_listed', kind, detail: `${kind}: candidate has an empty agent or owner` };

    let pick: Agent | undefined;
    const handles: Record<(typeof RULE_ORDER)[number], string[]> = {
      implementer: [],
      client: [],
      other_reviewer: [],
      same_bot: [],
    };

    // Selection is greedy in `kinds` order: an earlier kind can take the only
    // candidate a later kind needs. `pr-work listing` reports that refusal; the
    // caller reorders the lists.
    for (const candidate of candidates) {
      if (candidate.agent === input.implementer.agent) {
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
      const bot = candidate.github_user_id;
      if (
        bot !== undefined &&
        (bot === input.implementer.github_user_id ||
          (input.opener && bot === input.opener.github_user_id) ||
          picks.some((p) => p.agent.github_user_id === bot))
      ) {
        handles.same_bot.push(candidate.handle);
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
