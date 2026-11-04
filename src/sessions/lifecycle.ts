import * as fs from 'fs';
import * as path from 'path';
import { git } from '../git/git';
import { createWorktree, removeWorktree } from '../git/worktree';
import { Ticket } from '../tickets/source';
import { Session, sessionSlugBase } from './model';
import { SessionStore } from './store';
import { renderAdhocTask, renderTicketTask } from './task';

export interface StartSessionOptions {
  repo: string;
  baseRef: string;
  store: SessionStore;
  ticket?: Ticket;
  adhoc?: { title: string; description: string };
  worktreeRoot?: string;
  now?: Date;
}

// Per-session files (TASK.md, later status and hooks) live here and are never committed.
export const WORKBENCH_DIR = '.workbench';
const MAX_SESSIONS_PER_BASE = 100;

export async function startSession(opts: StartSessionOptions): Promise<Session> {
  const { repo, baseRef, store, ticket, adhoc } = opts;
  if (!ticket && !adhoc) {
    throw new Error('a session needs a ticket or an ad-hoc title');
  }
  const base = sessionSlugBase(ticket, adhoc?.title);
  const taken = new Set(store.list().map((s) => s.id));

  for (let n = 1; n <= MAX_SESSIONS_PER_BASE; n++) {
    const id = `${base}-${n}`;
    if (taken.has(id)) {
      continue;
    }
    let wt;
    try {
      wt = await createWorktree({ repo, slug: id, baseRef, root: opts.worktreeRoot });
    } catch (e) {
      // A branch kept from a deleted session still occupies this number.
      if (/already exists/.test((e as Error).message)) {
        continue;
      }
      throw e;
    }

    await excludeWorkbenchDir(wt.path);
    fs.mkdirSync(path.join(wt.path, WORKBENCH_DIR), { recursive: true });
    const task = ticket ? renderTicketTask(ticket) : renderAdhocTask(adhoc!.title, adhoc!.description);
    fs.writeFileSync(path.join(wt.path, WORKBENCH_DIR, 'TASK.md'), task);

    const session: Session = {
      id,
      repo,
      worktree: wt.path,
      branch: wt.branch,
      baseRef,
      createdAt: (opts.now ?? new Date()).toISOString(),
      ...(ticket
        ? { ticket: { source: ticket.source, id: ticket.id, title: ticket.title, ...(ticket.url ? { url: ticket.url } : {}) } }
        : { title: adhoc!.title }),
    };
    store.add(session);
    return session;
  }
  throw new Error(`too many sessions for "${base}"`);
}

// Removes the worktree folder (keeping its branch) and the record. Without force, uncommitted work blocks it.
export async function deleteSession(store: SessionStore, session: Session, opts: { force?: boolean } = {}): Promise<void> {
  if (fs.existsSync(session.worktree)) {
    await removeWorktree(session.repo, session.worktree, opts);
  } else {
    await git(session.repo, ['worktree', 'prune']);
  }
  store.remove(session.id);
}

// info/exclude is shared by all worktrees of a repo, so this also covers the main working tree.
async function excludeWorkbenchDir(worktree: string): Promise<void> {
  const commonDir = path.resolve(worktree, (await git(worktree, ['rev-parse', '--git-common-dir'])).trim());
  const exclude = path.join(commonDir, 'info', 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const entry = `/${WORKBENCH_DIR}/`;
  if (!current.split(/\r?\n/).includes(entry)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  }
}
