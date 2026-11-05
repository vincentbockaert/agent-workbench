// Pull requests as the ticket tab shows them. Pure: parses what `gh pr list --json` prints, no vscode, no network.
import { branchMatchesTicket } from '../tickets/work';

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';
export type ReviewState = 'approved' | 'changes' | 'required' | 'none';

export interface PullRequest {
  repo: string; // folder name of the repository, shown next to the number
  repoRoot: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  branch: string; // head
  base: string;
  author?: string;
  updatedAt: string;
  mergedAt?: string;
  review: ReviewState;
  checks: ChecksState;
  conflicts: boolean;
}

// The fields requested from `gh pr list --json`.
export const GH_PR_FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,author,updatedAt,mergedAt,reviewDecision,statusCheckRollup,mergeable';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function stateOf(item: Json): PrState {
  const s = str(item.state);
  if (s === 'MERGED') {
    return 'merged';
  }
  if (s === 'CLOSED') {
    return 'closed';
  }
  return item.isDraft === true ? 'draft' : 'open';
}

function reviewOf(v: unknown): ReviewState {
  return v === 'APPROVED' ? 'approved' : v === 'CHANGES_REQUESTED' ? 'changes' : v === 'REVIEW_REQUIRED' ? 'required' : 'none';
}

// Fail beats pending beats pass. Skipped, neutral and cancelled checks say nothing either way; unreadable items are ignored.
function checksOf(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup)) {
    return 'none';
  }
  let pass = false;
  let pending = false;
  for (const c of rollup) {
    if (!isObject(c)) {
      continue;
    }
    if (c.__typename === 'StatusContext') {
      const state = str(c.state);
      if (state === 'FAILURE' || state === 'ERROR') {
        return 'fail';
      }
      if (state === 'PENDING' || state === 'EXPECTED') {
        pending = true;
      } else if (state === 'SUCCESS') {
        pass = true;
      }
    } else if (c.__typename === 'CheckRun') {
      const conclusion = str(c.conclusion);
      if (str(c.status) !== 'COMPLETED') {
        pending = true;
      } else if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'STARTUP_FAILURE') {
        return 'fail';
      } else if (conclusion === 'ACTION_REQUIRED') {
        pending = true;
      } else if (conclusion === 'SUCCESS') {
        pass = true;
      }
    }
  }
  return pending ? 'pending' : pass ? 'pass' : 'none';
}

// Entries that are not pull requests (missing number, title or url) are skipped.
export function parsePullRequests(json: unknown, repo: { name: string; root: string }): PullRequest[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const out: PullRequest[] = [];
  for (const item of json) {
    if (!isObject(item) || typeof item.number !== 'number' || typeof item.title !== 'string' || typeof item.url !== 'string') {
      continue;
    }
    const author = isObject(item.author) ? str(item.author.login) : undefined;
    out.push({
      repo: repo.name,
      repoRoot: repo.root,
      number: item.number,
      title: item.title,
      url: item.url,
      state: stateOf(item),
      branch: str(item.headRefName) ?? '',
      base: str(item.baseRefName) ?? '',
      ...(author ? { author } : {}),
      updatedAt: str(item.updatedAt) ?? '',
      ...(str(item.mergedAt) ? { mergedAt: str(item.mergedAt) } : {}),
      review: reviewOf(item.reviewDecision),
      checks: checksOf(item.statusCheckRollup),
      conflicts: item.mergeable === 'CONFLICTING',
    });
  }
  return out;
}

const STATE_ORDER: Record<PrState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

// Open ones first, then draft, merged, closed; newest first within each.
export function sortPullRequests(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// The PRs that belong to a ticket: head branch is one of its known branches, or carries its key, or the title does.
export function prsForTicket(prs: PullRequest[], ticket: { id: string }, branches: Set<string>): PullRequest[] {
  return sortPullRequests(prs.filter((p) => branches.has(p.branch) || branchMatchesTicket(p.branch, ticket.id) || branchMatchesTicket(p.title, ticket.id)));
}
