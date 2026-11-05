import { defaultBranch, listLocalBranches, listWorktrees, WorktreeEntry } from '../git/branches';
import type { RepoInfo } from '../git/repos';
import type { Session } from '../sessions/model';
import { workForTicket } from './work';

export interface RepoWork {
  repo: RepoInfo;
  baseRef?: string; // what other work is compared against; undefined = no default branch found
  branches: string[];
  worktrees: WorktreeEntry[];
}

// A branch carrying a ticket's work that no workbench session owns.
export interface ManualBranch {
  repo: RepoInfo;
  branch: string;
  baseRef?: string;
  worktree?: string;
}

type Read = () => Promise<RepoWork | undefined>;

// Branches and worktrees of every repo, read once and kept until invalidated, so expanding tickets never
// runs git per click. Reads are capped (a parent folder can hold 30+ repos); a repo that fails is left out.
export class WorkIndex {
  private readonly cache = new Map<string, Promise<RepoWork | undefined>>();
  private readonly settled = new Map<string, RepoWork | undefined>();

  constructor(
    private readonly repos: () => RepoInfo[],
    private readonly concurrency = 4,
    // Wraps each repo read; tests use it to observe how many run at once.
    private readonly wrap: (read: Read) => Promise<RepoWork | undefined> = (read) => read(),
  ) {}

  // Forget what was read: all repos, or one (after changing it).
  invalidate(repoRoot?: string): void {
    if (repoRoot === undefined) {
      this.cache.clear();
      this.settled.clear();
    } else {
      this.cache.delete(repoRoot);
      this.settled.delete(repoRoot);
    }
  }

  // Reads every repo not read yet; repos that fail to read are left out.
  async ensure(): Promise<RepoWork[]> {
    const repos = this.repos();
    const pending = repos.filter((r) => !this.cache.has(r.root));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let r = pending[next++]; r !== undefined; r = pending[next++]) {
        const reading = this.wrap(() => readRepo(r));
        this.cache.set(r.root, reading);
        const value = await reading;
        // Skip if invalidated while reading, so stale data never sticks.
        if (this.cache.get(r.root) === reading) {
          this.settled.set(r.root, value);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
    const all = await Promise.all(repos.map((r) => this.cache.get(r.root)));
    return all.filter((w): w is RepoWork => w !== undefined);
  }

  // What is read so far, or undefined while any current repo is still unread.
  peek(): RepoWork[] | undefined {
    const repos = this.repos();
    if (repos.some((r) => !this.settled.has(r.root))) {
      return undefined;
    }
    return repos.map((r) => this.settled.get(r.root)).filter((w): w is RepoWork => w !== undefined);
  }
}

async function readRepo(repo: RepoInfo): Promise<RepoWork | undefined> {
  try {
    const [branches, worktrees, baseRef] = await Promise.all([listLocalBranches(repo.root), listWorktrees(repo.root), defaultBranch(repo.root)]);
    return { repo, baseRef, branches, worktrees };
  } catch {
    return undefined;
  }
}

// The key-matching branches that no session of this ticket owns, across all repos: sorted by repo, then name.
export function manualBranchesForTicket(work: RepoWork[], ticket: { source: string; id: string }, sessions: Session[]): ManualBranch[] {
  const found: ManualBranch[] = [];
  for (const w of work) {
    for (const b of workForTicket({ ticket, repo: w.repo.root, sessions, branches: w.branches, worktrees: w.worktrees })) {
      if (!b.session) {
        found.push({ repo: w.repo, branch: b.branch, baseRef: w.baseRef, worktree: b.worktree });
      }
    }
  }
  return found;
}
