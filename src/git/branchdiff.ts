import { diffStats, LineStats, mergeBase } from './diff';
import { git } from './git';
import { changedFiles, ChangedFile, ChangeStatus } from './worktree';

// A branch whose changes are shown for a ticket. With a worktree the uncommitted state is included and the
// diff's right side is the real file; without one only committed changes exist and everything is read from git.
export interface BranchTarget {
  repo: string;
  branch: string;
  baseRef: string;
  worktree?: string;
}

async function branchMergeBase(repo: string, branch: string, baseRef: string): Promise<string> {
  return (await git(repo, ['merge-base', baseRef, branch])).trim();
}

function toStatus(code: string): ChangeStatus {
  return code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified'; // M, T (type change), U (unmerged)
}

// Committed changes of `branch` since it left `baseRef` (merge-base..branch), run in the repo. Renames show as delete + add.
export async function changedFilesForBranch(repo: string, branch: string, baseRef: string): Promise<ChangedFile[]> {
  const base = await branchMergeBase(repo, branch, baseRef);
  const out = await git(repo, ['diff', '--name-status', '--no-renames', '-z', base, branch]);
  const parts = out.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ path: parts[i + 1], status: toStatus(parts[i]) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Lines added/removed per path for the same range; binary files are missing from the map.
export async function diffStatsForBranch(repo: string, branch: string, baseRef: string): Promise<Map<string, LineStats>> {
  const base = await branchMergeBase(repo, branch, baseRef);
  const stats = new Map<string, LineStats>();
  // -z numstat: "<added>\t<removed>\t<path>\0"; binary files show "-" for both counts.
  const out = await git(repo, ['diff', '--numstat', '--no-renames', '-z', base, branch]);
  for (const entry of out.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = entry.split('\t');
    if (added !== '-') {
      stats.set(rest.join('\t'), { added: Number(added), removed: Number(removed) });
    }
  }
  return stats;
}

// The commit the branch left the base at; the left side of every diff of this branch.
export async function targetMergeBase(t: BranchTarget): Promise<string> {
  return t.worktree ? mergeBase(t.worktree, t.baseRef) : branchMergeBase(t.repo, t.branch, t.baseRef);
}

// The files and line counts to show for a branch: with a worktree its full state (uncommitted and untracked
// included), without one the committed changes.
export async function changesForTarget(t: BranchTarget): Promise<{ files: ChangedFile[]; stats: Map<string, LineStats> }> {
  const [files, stats] = t.worktree
    ? await Promise.all([changedFiles(t.worktree, t.baseRef), diffStats(t.worktree, t.baseRef)])
    : await Promise.all([changedFilesForBranch(t.repo, t.branch, t.baseRef), diffStatsForBranch(t.repo, t.branch, t.baseRef)]);
  return { files, stats };
}
