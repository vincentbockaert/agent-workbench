import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../src/git/git';
import { changedFiles } from '../../src/git/worktree';
import { deleteSession, hasOtherTicketSessions, startSession } from '../../src/sessions/lifecycle';
import { Session, sessionSlugBase } from '../../src/sessions/model';
import { SessionStore } from '../../src/sessions/store';
import { renderAdhocTask, renderTicketTask } from '../../src/sessions/task';
import { Ticket } from '../../src/tickets/source';
import { groupWork } from '../../src/ui/group';
import { makeRepo } from './helpers/repo';

const ghTicket: Ticket = {
  source: 'GitHub',
  id: '42',
  title: 'Crash on empty config',
  status: 'OPEN',
  url: 'https://github.com/o/r/issues/42',
  raw: { number: 42, title: 'Crash on empty config', body: 'Steps: run with {}' },
};

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, repo: '/r', worktree: `/w/${id}`, branch: `wb/${id}`, baseRef: 'main', createdAt: '2026-11-04T10:00:00.000Z', ...extra };
}

describe('sessions', function () {
  this.timeout(20000);

  describe('sessionSlugBase', () => {
    it('combines source and ticket id, lowercased and filesystem/branch safe', () => {
      assert.equal(sessionSlugBase({ source: 'GitHub', id: '42', title: 't' }), 'github-42');
      assert.equal(sessionSlugBase({ source: 'Jira', id: 'PROJ-123', title: 't' }), 'jira-proj-123');
      assert.equal(sessionSlugBase({ source: 'My Board', id: 'a/b c', title: 't' }), 'my-board-a-b-c');
    });

    it('uses "adhoc-" plus the title for ad-hoc sessions, capped at 40 characters', () => {
      assert.equal(sessionSlugBase(undefined, 'Try the new parser!'), 'adhoc-try-the-new-parser');
      const long = sessionSlugBase(undefined, 'x'.repeat(100));
      assert.ok(long.length <= 40 && !long.endsWith('-'));
    });

    it('falls back to "adhoc" when the title has no usable characters', () => {
      assert.equal(sessionSlugBase(undefined, '???'), 'adhoc');
    });
  });

  describe('TASK.md', () => {
    it('renders a ticket with id, title, source, status, url and the raw tracker data', () => {
      const md = renderTicketTask(ghTicket);
      assert.match(md, /^# 42: Crash on empty config$/m);
      assert.match(md, /Source: GitHub/);
      assert.match(md, /Status: OPEN/);
      assert.match(md, /https:\/\/github\.com\/o\/r\/issues\/42/);
      assert.match(md, /Steps: run with \{\}/);
    });

    it('is deterministic for the same ticket', () => {
      assert.equal(renderTicketTask(ghTicket), renderTicketTask({ ...ghTicket }));
    });

    it('renders an ad-hoc task from title and description', () => {
      assert.equal(renderAdhocTask('Spike', 'Try X'), '# Spike\n\nTry X\n');
    });
  });

  describe('SessionStore', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
      file = path.join(dir, 'sessions.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('starts empty without a warning when no file exists', () => {
      const store = new SessionStore(file);
      assert.deepEqual(store.list(), []);
      assert.equal(store.warning, undefined);
    });

    it('persists added and removed sessions across instances', () => {
      const a = new SessionStore(file);
      a.add(session('github-42-1'));
      a.add(session('github-42-2'));
      a.remove('github-42-1');
      assert.deepEqual(new SessionStore(file).list().map((s) => s.id), ['github-42-2']);
    });

    it('rejects adding a duplicate id', () => {
      const store = new SessionStore(file);
      store.add(session('x-1'));
      assert.throws(() => store.add(session('x-1')), /already/);
    });

    it('treats a corrupt file as empty, warns, and keeps the bad file as a backup', () => {
      fs.writeFileSync(file, '{not json');
      const store = new SessionStore(file);
      assert.deepEqual(store.list(), []);
      assert.match(store.warning ?? '', /sessions\.json/);
      const backups = fs.readdirSync(dir).filter((f) => f.startsWith('sessions.json.corrupt-'));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{not json');
    });
  });

  describe('startSession / deleteSession (real git)', () => {
    let parent: string;
    let repo: string;
    let store: SessionStore;
    const now = new Date('2026-11-04T10:00:00Z');

    beforeEach(async () => {
      ({ parent, repo } = await makeRepo());
      store = new SessionStore(path.join(parent, 'state', 'sessions.json'));
    });
    afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

    it('creates a worktree for the ticket, writes TASK.md, and records the session', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });

      assert.equal(s.id, 'github-42-1');
      assert.equal(s.branch, 'wb/github-42-1');
      assert.equal(s.worktree, path.join(parent, 'repo.worktrees', 'github-42-1'));
      assert.deepEqual(s.ticket, { source: 'GitHub', id: '42', title: 'Crash on empty config', url: ghTicket.url });
      assert.equal(s.createdAt, now.toISOString());
      assert.equal(fs.readFileSync(path.join(s.worktree, '.workbench', 'TASK.md'), 'utf8'), renderTicketTask(ghTicket));
      assert.deepEqual(store.list(), [s]);
    });

    it('keeps .workbench out of git: not a change in the session, main tree stays clean', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      assert.deepEqual(await changedFiles(s.worktree, 'main'), []);
      assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '');
    });

    it('numbers further sessions for the same ticket', async () => {
      await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      const second = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      assert.equal(second.id, 'github-42-2');
    });

    it('skips numbers whose branch survived a deleted session', async () => {
      const first = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      await deleteSession(store, first);
      const next = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      assert.equal(next.id, 'github-42-2');
    });

    it('starts an ad-hoc session with its own TASK.md', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, adhoc: { title: 'Spike', description: 'Try X' }, now });
      assert.equal(s.id, 'adhoc-spike-1');
      assert.equal(s.ticket, undefined);
      assert.equal(s.title, 'Spike');
      assert.equal(fs.readFileSync(path.join(s.worktree, '.workbench', 'TASK.md'), 'utf8'), '# Spike\n\nTry X\n');
    });

    it('deletes the worktree and the record but keeps the branch', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      await deleteSession(store, s);
      assert.ok(!fs.existsSync(s.worktree));
      assert.deepEqual(store.list(), []);
      assert.match(await git(repo, ['branch', '--list', s.branch]), /github-42-1/);
    });

    it('refuses to delete a session with uncommitted work unless forced, keeping the record', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      fs.writeFileSync(path.join(s.worktree, 'edit.txt'), 'agent work\n');

      await assert.rejects(deleteSession(store, s));
      assert.equal(store.list().length, 1);

      await deleteSession(store, s, { force: true });
      assert.deepEqual(store.list(), []);
    });

    it('drops the record when the worktree folder is already gone', async () => {
      const s = await startSession({ repo, baseRef: 'main', store, ticket: ghTicket, now });
      fs.rmSync(s.worktree, { recursive: true, force: true });
      await deleteSession(store, s);
      assert.deepEqual(store.list(), []);
    });
  });

  describe('groupWork', () => {
    const gh = { name: 'GitHub', listCmd: 'x', map: { id: 'number', title: 'title' } };
    const snap = { source: 'GitHub', fetchedAt: '2026-11-04T10:00:00.000Z', tickets: [ghTicket] };

    it('puts sessions under their listed ticket', () => {
      const s = session('github-42-1', { ticket: { source: 'GitHub', id: '42', title: 'old title' } });
      const model = groupWork([gh], [snap], [s]);
      assert.equal(model.sources[0].tickets.length, 1);
      assert.equal(model.sources[0].tickets[0].ticket, ghTicket);
      assert.equal(model.sources[0].tickets[0].listed, true);
      assert.deepEqual(model.sources[0].tickets[0].sessions, [s]);
      assert.deepEqual(model.other, []);
    });

    it('keeps tickets that left the tracker list visible when they still have sessions', () => {
      const t = { source: 'GitHub', id: '99', title: 'Closed meanwhile' };
      const s = session('github-99-1', { ticket: t });
      const tickets = groupWork([gh], [snap], [s]).sources[0].tickets;
      assert.deepEqual(tickets.map((g) => [g.ticket.id, g.listed, g.sessions.length]), [
        ['42', true, 0],
        ['99', false, 1],
      ]);
    });

    it('puts ad-hoc sessions and sessions of unconfigured sources under "other"', () => {
      const adhoc = session('adhoc-spike-1', { title: 'Spike' });
      const orphan = session('trello-a-1', { ticket: { source: 'Trello', id: 'a', title: 'T' } });
      assert.deepEqual(groupWork([gh], [snap], [adhoc, orphan]).other, [adhoc, orphan]);
    });

    it('works without a snapshot (never refreshed)', () => {
      const s = session('github-42-1', { ticket: { source: 'GitHub', id: '42', title: 'T' } });
      const tickets = groupWork([gh], [undefined], [s]).sources[0].tickets;
      assert.deepEqual(tickets.map((g) => [g.ticket.id, g.listed]), [['42', false]]);
    });
  });
});

describe('hasOtherTicketSessions', () => {
  const s = (id: string, ticketId?: string, source = 'Jira'): Session => ({
    id,
    repo: '/r',
    worktree: `/w/${id}`,
    branch: `wb/${id}`,
    baseRef: 'main',
    createdAt: 't',
    ...(ticketId ? { ticket: { source, id: ticketId, title: 'T' } } : { title: 'Ad-hoc' }),
  });

  it('is false when the session was the ticket\'s only one (the removed session itself does not count)', () => {
    const one = s('jira-p-1-1', 'P-1');
    assert.equal(hasOtherTicketSessions([one], one), false);
    assert.equal(hasOtherTicketSessions([], one), false);
  });

  it('is true while another session of the same ticket remains', () => {
    const a = s('jira-p-1-1', 'P-1');
    assert.equal(hasOtherTicketSessions([a, s('jira-p-1-2', 'P-1')], a), true);
  });

  it('does not confuse tickets with the same id in another source, or ad-hoc sessions', () => {
    const a = s('jira-p-1-1', 'P-1');
    assert.equal(hasOtherTicketSessions([a, s('gh-p-1-1', 'P-1', 'GitHub'), s('adhoc-x-1')], a), false);
    const adhoc = s('adhoc-x-1');
    assert.equal(hasOtherTicketSessions([adhoc, s('adhoc-y-1')], adhoc), false);
  });
});
