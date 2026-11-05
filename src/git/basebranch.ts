import * as fs from 'fs';
import { defaultBranch, listWorktrees } from './branches';
import { git } from './git';

// A branch a new session can start from, with what the user should know before choosing it.
export interface BaseChoice {
  ref: string; // what is passed to `git worktree add`: "main" or "origin/main"
  kind: 'local' | 'remote';
  isDefault: boolean; // the repository's default branch (the remote-tracking one and its local twin)
  isCurrent: boolean; // checked out in this repo's own folder
  worktree?: string; // another working tree has it checked out: its uncommitted work is NOT part of the base
  isSession: boolean; // a workbench session branch (wb/...)
  updated?: string; // last commit, relative ("3 days ago")
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

async function relativeDate(repo: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(repo, ['log', '-1', '--format=%cr', ref])).trim() || undefined;
  } catch {
    return undefined;
  }
}

// The branches a session can start from, in the order they should be offered: the repository's default branch
// (remote-tracking first, then the local one), the branch checked out in the repo's own folder, then every other
// local branch, most recently committed first. Remote branches other than the default are not listed.
export async function listBaseChoices(repo: string): Promise<BaseChoice[]> {
  const self = real(repo);
  const [worktrees, def, listing] = await Promise.all([
    listWorktrees(repo),
    defaultBranch(repo),
    git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:relative)', 'refs/heads']),
  ]);
  const own = worktrees.find((w) => real(w.path) === self) ?? worktrees[0];
  const elsewhere = new Map<string, string>();
  for (const w of worktrees) {
    if (w !== own && w.branch !== undefined) {
      elsewhere.set(w.branch, real(w.path));
    }
  }
  const locals = listing
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => {
      const [ref, updated] = l.split('\t');
      return { ref, updated };
    });

  const isRemoteDefault = def !== undefined && !locals.some((l) => l.ref === def) && def.includes('/');
  const localName = def === undefined ? undefined : isRemoteDefault ? def.slice(def.indexOf('/') + 1) : def;
  const choices: BaseChoice[] = [];
  const local = (ref: string, updated: string | undefined): BaseChoice => ({
    ref,
    kind: 'local',
    isDefault: ref === localName,
    isCurrent: ref === own?.branch,
    worktree: elsewhere.get(ref),
    isSession: ref.startsWith('wb/'),
    updated,
  });

  if (isRemoteDefault && def !== undefined) {
    choices.push({ ref: def, kind: 'remote', isDefault: true, isCurrent: false, isSession: false, updated: await relativeDate(repo, def) });
  }
  const used = new Set<string>();
  const add = (ref: string | undefined) => {
    const found = locals.find((l) => l.ref === ref);
    if (found && !used.has(found.ref)) {
      used.add(found.ref);
      choices.push(local(found.ref, found.updated));
    }
  };
  add(localName);
  add(own?.branch);
  for (const l of locals) {
    add(l.ref);
  }
  return choices;
}

export type BaseMode = 'ask' | 'default-branch' | 'current';

// What to do about the base branch of a new session, given the user's setting.
// "default-branch" and "current" skip the question when they can be honoured; otherwise the user is asked.
export function resolveBase(mode: BaseMode, choices: BaseChoice[]): { ref: string } | { ask: BaseChoice[] } | { error: string } {
  if (choices.length === 0) {
    return { error: 'This repository has no branch to start from; make a first commit.' };
  }
  if (mode === 'default-branch') {
    const def = choices.find((c) => c.isDefault);
    if (def) {
      return { ref: def.ref };
    }
  } else if (mode === 'current') {
    const current = choices.find((c) => c.isCurrent);
    if (current) {
      return { ref: current.ref };
    }
  }
  return { ask: choices };
}

// The words shown for a choice in the quick pick. A warning means "think before picking this".
export function describeBase(c: BaseChoice): { label: string; description: string; warning?: string } {
  const parts: string[] = [];
  if (c.isDefault) {
    parts.push('default');
  }
  if (c.kind === 'remote') {
    parts.push('remote, as of your last fetch');
  }
  if (c.isCurrent) {
    parts.push('checked out here');
  }
  if (c.updated) {
    parts.push(c.updated);
  }
  let warning: string | undefined;
  if (c.isSession) {
    warning = `A workbench session branch: another agent's work in progress${c.worktree ? ` (checked out in ${c.worktree}); its uncommitted changes are not part of the base` : ''}`;
  } else if (c.worktree) {
    warning = `Checked out in another worktree (${c.worktree}): its uncommitted changes are not part of the base`;
  }
  return { label: c.ref, description: parts.join(' · '), ...(warning ? { warning } : {}) };
}
