import * as fs from 'fs';
import * as path from 'path';
import { git } from './git';

export interface Worktree {
  path: string;
  branch: string;
}

export interface CreateWorktreeOptions {
  repo: string;
  slug: string;
  baseRef: string;
  // Folder that holds all worktrees of this repo; defaults to "<repo>.worktrees" next to the repo.
  root?: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const BRANCH_PREFIX = 'wb/';

export function defaultWorktreeRoot(repo: string): string {
  const resolved = path.resolve(repo);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<Worktree> {
  const { repo, slug, baseRef } = opts;
  if (!SLUG.test(slug) || slug.includes('..')) {
    throw new Error(`invalid slug "${slug}": use lowercase letters, digits, ".", "-" or "_"`);
  }
  const wtPath = path.join(opts.root ?? defaultWorktreeRoot(repo), slug);
  const branch = BRANCH_PREFIX + slug;

  const branchExists = (await git(repo, ['branch', '--list', branch])).trim() !== '';
  if (branchExists || fs.existsSync(wtPath)) {
    throw new Error(`worktree "${slug}" already exists (branch ${branch} or folder ${wtPath})`);
  }
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`unknown base ref "${baseRef}"`);
  }

  await git(repo, ['worktree', 'add', '-q', '-b', branch, wtPath, baseRef]);
  return { path: wtPath, branch };
}

// Keeps the branch, so the session's work stays reachable after its folder is gone.
export async function removeWorktree(repo: string, worktreePath: string, opts: { force?: boolean } = {}): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktreePath]);
}

// Everything that differs from the point where the session branched off the base:
// committed and uncommitted changes, plus untracked (non-ignored) files. Renames show as delete + add.
export async function changedFiles(worktreePath: string, baseRef: string): Promise<ChangedFile[]> {
  const mergeBase = (await git(worktreePath, ['merge-base', baseRef, 'HEAD'])).trim();
  const diff = await git(worktreePath, ['diff', '--name-status', '--no-renames', '-z', mergeBase]);
  const untracked = await git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);

  const files: ChangedFile[] = [];
  const parts = diff.split('\0').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ path: parts[i + 1], status: toStatus(parts[i]) });
  }
  for (const p of untracked.split('\0').filter(Boolean)) {
    files.push({ path: p, status: 'untracked' });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function toStatus(code: string): ChangeStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'modified'; // M, T (type change), U (unmerged)
  }
}

// Checks an existing branch out into a new worktree next to the repo (no agent, no session) and returns its path.
export async function addWorktreeForBranch(repo: string, branch: string, root?: string): Promise<string> {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+|-+$/g, '');
  if (!SLUG.test(slug)) {
    throw new Error(`Cannot derive a folder name from branch "${branch}".`);
  }
  const dir = path.join(root ?? defaultWorktreeRoot(repo), slug);
  if (fs.existsSync(dir)) {
    throw new Error(`${dir} already exists.`);
  }
  await git(repo, ['worktree', 'add', dir, branch]);
  return dir;
}
