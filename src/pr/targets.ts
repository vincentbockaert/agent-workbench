import { workForTicket } from '../tickets/work';
import type { RepoWork } from '../tickets/workIndex';
import type { Session } from '../sessions/model';
import type { PrTarget } from './cache';

// The repos worth asking GitHub about for one ticket (those that carry its work) and the branches to look for.
// A repo without any branch of the ticket is skipped: nothing there can be its pull request, and with a parent folder
// of dozens of repos that keeps the number of `gh` calls small.
export function prTargets(work: RepoWork[], ticket: { source: string; id: string }, sessions: Session[]): PrTarget[] {
  const out: PrTarget[] = [];
  for (const w of work) {
    const branches = workForTicket({ ticket, repo: w.repo.root, sessions, branches: w.branches, worktrees: w.worktrees }).map((b) => b.branch);
    if (branches.length > 0) {
      out.push({ repo: { name: w.repo.name, root: w.repo.root }, branches });
    }
  }
  return out;
}
