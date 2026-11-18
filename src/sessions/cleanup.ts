// Which sessions can have their worktree removed, and why. Pure classification: reads git and PR data, removes nothing.
// Removal itself is `deleteSession`, which keeps the branch. The only hard gate is a clean working tree; the
// reasons (merged, closed, pushed, ...) tell the user why a session is a candidate.
import * as fs from 'fs';
import { git } from '../git/git';
import type { PullRequest } from '../pr/model';
import type { Session } from './model';

export type PrReason = 'merged' | 'closed' | 'open' | 'none';

export type CleanupReason =
  | 'pr-merged' // the PR was merged (also covers squash and rebase merges)
  | 'pr-closed' // the PR was closed without merging
  | 'on-base' // the branch's commits are already in the base branch (plain merge)
  | 'pushed' // all commits are on the remote branch
  | 'local-only' // commits that exist only on this machine: a warning, not a reason to remove
  | 'empty' // no work was ever committed
  | 'idle'; // nothing happened for a long time

export interface CleanupCandidate {
  session: Session;
  reasons: CleanupReason[];
  blockers: string[]; // non-empty: removal is not allowed
  suggested: boolean; // clean, and merged, closed or already on the base
}

export const DEFAULT_IDLE_DAYS = 14;
const DAY_MS = 86_400_000;

async function ok(repo: string, args: string[]): Promise<boolean> {
  try {
    await git(repo, args);
    return true;
  } catch {
    return false;
  }
}

async function tryGit(repo: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(repo, args)).trim();
  } catch {
    return undefined;
  }
}

// Whether every commit of the branch is already reachable from the base. False when either ref is missing.
export function isOnBase(repo: string, branch: string, baseRef: string): Promise<boolean> {
  return ok(repo, ['merge-base', '--is-ancestor', branch, baseRef]);
}

// Whether origin has the branch with all its commits. False without a remote branch.
export async function isPushed(repo: string, branch: string, remote = 'origin'): Promise<boolean> {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  if (!(await ok(repo, ['rev-parse', '--verify', '--quiet', remoteRef]))) {
    return false;
  }
  return ok(repo, ['merge-base', '--is-ancestor', branch, remoteRef]);
}

// The state of the session's PR. An open PR wins over a merged one, which wins over a closed one (a branch can be reused).
export function prReason(session: Session, prs: PullRequest[]): PrReason {
  const states = prs.filter((p) => p.repoRoot === session.repo && p.branch === session.branch).map((p) => p.state);
  if (states.some((s) => s === 'open' || s === 'draft')) {
    return 'open';
  }
  if (states.includes('merged')) {
    return 'merged';
  }
  return states.includes('closed') ? 'closed' : 'none';
}

// What makes removal unsafe: uncommitted or untracked work. `.workbench/` (the session's own task files) does not count.
export async function blockers(session: Session): Promise<string[]> {
  if (!fs.existsSync(session.worktree)) {
    return [];
  }
  let out: string;
  try {
    out = await git(session.worktree, ['status', '--porcelain', '-z', '--untracked-files=all']); // not trimmed: entries start with a space
  } catch {
    return ['cannot read the working tree status'];
  }
  const files = out
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((f) => f !== '.workbench' && !f.startsWith('.workbench/'));
  return files.length ? [`uncommitted changes: ${files.join(', ')}`] : [];
}

async function commitsAhead(repo: string, branch: string, baseRef: string): Promise<number> {
  const n = await tryGit(repo, ['rev-list', '--count', `${baseRef}..${branch}`]);
  return n === undefined ? 0 : Number(n);
}

async function tipTime(repo: string, branch: string): Promise<number | undefined> {
  const t = await tryGit(repo, ['log', '-1', '--format=%ct', branch]);
  return t ? Number(t) * 1000 : undefined;
}

async function classify(session: Session, prs: PullRequest[], now: Date, idleDays: number): Promise<CleanupCandidate> {
  const { repo, branch, baseRef } = session;
  const [onBase, pushed, ahead, tip, block] = await Promise.all([
    isOnBase(repo, branch, baseRef),
    isPushed(repo, branch),
    commitsAhead(repo, branch, baseRef),
    tipTime(repo, branch),
    blockers(session),
  ]);
  const pr = prReason(session, prs);
  const created = Date.parse(session.createdAt);
  const reasons: CleanupReason[] = [];

  if (pr === 'merged') {
    reasons.push('pr-merged');
  }
  if (pr === 'closed') {
    reasons.push('pr-closed');
  }
  if (onBase) {
    // A branch without commits of its own is trivially "on the base": only commits made during the session count.
    reasons.push(tip !== undefined && !Number.isNaN(created) && tip >= created ? 'on-base' : 'empty');
  }
  if (pushed && ahead > 0) {
    reasons.push('pushed');
  }
  if (!pushed && !onBase && ahead > 0 && (pr === 'none' || pr === 'open')) {
    reasons.push('local-only');
  }
  const lastActivity = Math.max(tip ?? 0, Number.isNaN(created) ? 0 : created);
  if (lastActivity > 0 && now.getTime() - lastActivity >= idleDays * DAY_MS) {
    reasons.push('idle');
  }

  const suggested = block.length === 0 && reasons.some((r) => r === 'pr-merged' || r === 'pr-closed' || r === 'on-base');
  return { session, reasons, blockers: block, suggested };
}

// Every session with at least one reason to be cleaned up (or a blocker explaining why not), in input order.
export async function removalCandidates(sessions: Session[], prs: PullRequest[], now: Date = new Date(), idleDays = DEFAULT_IDLE_DAYS): Promise<CleanupCandidate[]> {
  const all = await Promise.all(sessions.map((s) => classify(s, prs, now, idleDays)));
  return all.filter((c) => c.reasons.length > 0);
}
