import * as fs from 'fs';
import * as path from 'path';
import { git } from './git';

// Line counts and base-side content for a session's changes. Kept apart from worktree.ts,
// whose changedFiles() result shape is fixed by its tests.

export interface LineStats {
  added: number;
  removed: number;
}

// Lines added/removed per changed path since the session branched off the base, untracked files included.
// Binary files are missing from the map.
export async function diffStats(worktreePath: string, baseRef: string): Promise<Map<string, LineStats>> {
  const base = await mergeBase(worktreePath, baseRef);
  const stats = new Map<string, LineStats>();

  // -z numstat: "<added>\t<removed>\t<path>\0"; binary files show "-" for both counts.
  const numstat = await git(worktreePath, ['diff', '--numstat', '--no-renames', '-z', base]);
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = entry.split('\t');
    if (added !== '-') {
      stats.set(rest.join('\t'), { added: Number(added), removed: Number(removed) });
    }
  }

  const untracked = await git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const rel of untracked.split('\0').filter(Boolean)) {
    const lines = countTextLines(fs.readFileSync(path.join(worktreePath, rel)));
    if (lines !== undefined) {
      stats.set(rel, { added: lines, removed: 0 });
    }
  }
  return stats;
}

// Same heuristic as git: a NUL byte in the first 8000 bytes means binary.
function countTextLines(buf: Buffer): number | undefined {
  if (buf.subarray(0, 8000).includes(0)) {
    return undefined;
  }
  let lines = 0;
  for (const byte of buf) {
    if (byte === 0x0a) {
      lines++;
    }
  }
  return buf.length > 0 && buf[buf.length - 1] !== 0x0a ? lines + 1 : lines;
}

// The commit the session branched from; diffs compare against this, so later base commits never show up.
export async function mergeBase(worktreePath: string, baseRef: string): Promise<string> {
  return (await git(worktreePath, ['merge-base', baseRef, 'HEAD'])).trim();
}

// File content at a commit, '' when the file does not exist there (an added file).
export async function fileAtRef(worktreePath: string, ref: string, relPath: string): Promise<string> {
  await git(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); // unknown ref: throws
  const spec = `${ref}:${relPath.replace(/\\/g, '/')}`;
  try {
    await git(worktreePath, ['cat-file', '-e', spec]);
  } catch {
    return '';
  }
  return git(worktreePath, ['show', spec]);
}

export interface BaseQuery {
  worktree: string;
  ref: string;
  path: string;
}

// The query string of a base-side document URI; round-trips any path.
export function encodeBaseQuery(q: BaseQuery): string {
  return encodeURIComponent(JSON.stringify({ worktree: q.worktree, ref: q.ref, path: q.path }));
}

export function decodeBaseQuery(query: string): BaseQuery | undefined {
  try {
    const q = JSON.parse(decodeURIComponent(query)) as Partial<BaseQuery>;
    if (typeof q.worktree === 'string' && typeof q.ref === 'string' && typeof q.path === 'string') {
      return { worktree: q.worktree, ref: q.ref, path: q.path };
    }
  } catch {
    // fall through
  }
  return undefined;
}
