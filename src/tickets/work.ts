// Which branches carry a ticket's work. Pure logic, no vscode import.
import type { WorktreeEntry } from '../git/branches';
import { Session, sessionsInRepos } from '../sessions/model';

// Jira-style keys only (ABC-123). Numeric ids such as GitHub's "#12" are too loose to match by name.
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

// True when the branch name contains the ticket key, case-insensitively, delimited by non-alphanumerics:
// "feature/PROJ-1938-x" matches PROJ-1938, "proj-19381" and "xproj-1938" do not.
export function isTicketKey(id: string): boolean {
  return KEY.test(id);
}

export function branchMatchesTicket(branch: string, ticketId: string): boolean {
  if (!isTicketKey(ticketId)) {
    return false;
  }
  const key = ticketId.toLowerCase();
  const name = branch.toLowerCase();
  for (let at = name.indexOf(key); at !== -1; at = name.indexOf(key, at + 1)) {
    const before = name[at - 1];
    const after = name[at + key.length];
    if ((before === undefined || !/[a-z0-9]/.test(before)) && (after === undefined || !/[a-z0-9]/.test(after))) {
      return true;
    }
  }
  return false;
}

export interface WorkBranch {
  branch: string;
  worktree?: string; // where the branch is checked out; undefined = no checkout, committed changes only
  session?: Session; // set when a workbench session owns this branch
}

export interface WorkInput {
  ticket: { source: string; id: string };
  repo: string;
  sessions: Session[];
  branches: string[]; // local branch names of the repo
  worktrees: WorktreeEntry[];
}

// A ticket's work in one repo: its workbench sessions first (oldest first), then every other local branch
// whose name carries the ticket key, sorted by name. A session's branch is listed once, as the session.
export function workForTicket(input: WorkInput): WorkBranch[] {
  const { ticket, repo, branches, worktrees } = input;
  const mine = sessionsInRepos(input.sessions, [{ root: repo, name: '', workspaceRoot: '' }])
    .filter((s) => s.ticket?.source === ticket.source && s.ticket.id === ticket.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const work: WorkBranch[] = mine.map((s) => ({ branch: s.branch, worktree: s.worktree, session: s }));
  const taken = new Set(mine.map((s) => s.branch));
  const checkedOut = new Map<string, string>();
  for (const w of worktrees) {
    if (w.branch !== undefined) {
      checkedOut.set(w.branch, w.path);
    }
  }

  const manual = branches
    .filter((b) => !taken.has(b) && branchMatchesTicket(b, ticket.id))
    .sort((a, b) => a.localeCompare(b));
  for (const b of manual) {
    work.push({ branch: b, worktree: checkedOut.get(b), session: undefined });
  }
  return work;
}

