import { git } from './git';

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string; // short name; undefined when detached
  detached: boolean;
  main: boolean; // the repository's own working tree (always listed first by git)
}

// All working trees of the repository `repo` belongs to (it may itself be a linked worktree), main one first.
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    let entry: WorktreeEntry | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        entry = { path: line.slice('worktree '.length), head: '', detached: false, main: entries.length === 0 };
      } else if (entry && line.startsWith('HEAD ')) {
        entry.head = line.slice('HEAD '.length);
      } else if (entry && line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (entry && line === 'detached') {
        entry.detached = true;
      }
    }
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

// The ref other work is compared against: origin/HEAD when set, else local main or master. undefined if none exists.
export async function defaultBranch(repo: string): Promise<string | undefined> {
  try {
    const head = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (head) {
      return head;
    }
  } catch {
    // no origin/HEAD: fall through to local names
  }
  for (const name of ['main', 'master']) {
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return name;
    } catch {
      // not there, try the next one
    }
  }
  return undefined;
}

export async function listLocalBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return out.split(/\r?\n/).filter((l) => l.length > 0);
}
