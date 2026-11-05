import * as fs from 'fs';
import * as path from 'path';
import { git } from './git';

export interface RepoInfo {
  root: string; // the repository's top-level folder
  name: string; // folder name, used to label per-repo ticket sources
  workspaceRoot: string; // the workspace folder it was found from
}

async function topLevel(dir: string): Promise<string | undefined> {
  try {
    return fs.realpathSync.native((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return undefined;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Repos below a workspace folder: direct subfolders with a `.git` directory. A `.git` *file* marks a linked
// worktree or submodule, so the workbench's own `<repo>.worktrees/*` folders are never picked up.
function childRepos(folder: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && isDirectory(path.join(folder, e.name, '.git')))
    .map((e) => path.join(folder, e.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

// Order matters: a folder with its own `.git` is that repo; else its child repos win over an enclosing repo
// (a parent folder may sit inside e.g. a dotfiles repo); else a folder inside a repo is that repo.
async function reposOf(folder: string): Promise<string[]> {
  if (fs.existsSync(path.join(folder, '.git'))) {
    const top = await topLevel(folder);
    return top ? [top] : [];
  }
  const children = childRepos(folder).map((r) => fs.realpathSync.native(r));
  if (children.length > 0) {
    return children;
  }
  const top = await topLevel(folder);
  return top ? [top] : [];
}

// The repos the workbench works with for these workspace folders (see reposOf). Duplicates across folders
// are dropped.
export async function discoverRepos(workspaceFolders: string[]): Promise<RepoInfo[]> {
  const found = new Map<string, RepoInfo>();
  for (const folder of workspaceFolders) {
    if (!isDirectory(folder)) {
      continue;
    }
    const real = fs.realpathSync.native(folder);
    const roots = await reposOf(real);
    for (const root of roots) {
      if (!found.has(root)) {
        found.set(root, { root, name: path.basename(root), workspaceRoot: real });
      }
    }
  }
  return [...found.values()];
}
