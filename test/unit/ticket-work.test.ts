import { strict as assert } from 'assert';
import type { WorktreeEntry } from '../../src/git/branches';
import type { Session } from '../../src/sessions/model';
import { branchMatchesTicket, isTicketKey, workForTicket } from '../../src/tickets/work';

describe('ticket work', () => {
  describe('branchMatchesTicket', () => {
    it('matches the key inside a branch name, case-insensitively', () => {
      assert.equal(branchMatchesTicket('feature/PROJ-1938-env-traffic-read-only', 'PROJ-1938'), true);
      assert.equal(branchMatchesTicket('proj-1938', 'PROJ-1938'), true);
      assert.equal(branchMatchesTicket('PROJ-1938-x', 'proj-1938'), true);
      assert.equal(branchMatchesTicket('feat/proj-1995_nightly', 'PROJ-1995'), true);
      assert.equal(branchMatchesTicket('PROJ-1938', 'PROJ-1938'), true);
    });

    it('needs non-alphanumeric boundaries, so a shorter or longer number never matches', () => {
      assert.equal(branchMatchesTicket('feature/proj-1938', 'PROJ-19'), false);
      assert.equal(branchMatchesTicket('feature/proj-193', 'PROJ-1938'), false);
      assert.equal(branchMatchesTicket('feature/proj-19381', 'PROJ-1938'), false);
      assert.equal(branchMatchesTicket('feature/xproj-1938', 'PROJ-1938'), false);
      assert.equal(branchMatchesTicket('feature/proj-1938x', 'PROJ-1938'), false);
    });

    it('never matches numeric or otherwise non-key ids', () => {
      assert.equal(branchMatchesTicket('fix/12-login', '12'), false);
      assert.equal(branchMatchesTicket('fix/12-login', '#12'), false);
      assert.equal(branchMatchesTicket('anything', ''), false);
      assert.equal(branchMatchesTicket('feature/foo bar', 'foo bar'), false);
    });

    it('does not treat key characters as a pattern', () => {
      assert.equal(branchMatchesTicket('feature/projX1938', 'PROJ.1938'), false);
      assert.equal(branchMatchesTicket('feature/proj-1938', 'H.O-1938'), false);
    });
  });

  describe('workForTicket', () => {
    const repo = '/r/billing-api';
    const ticket = { source: 'Jira PROJ', id: 'PROJ-1938' };
    const wt = (p: string, branch: string | undefined, main = false): WorktreeEntry => ({
      path: p,
      head: 'abc',
      branch,
      detached: branch === undefined,
      main,
    });
    const session = (id: string, over: Partial<Session> = {}): Session => ({
      id,
      repo,
      worktree: `${repo}.worktrees/${id}`,
      branch: `wb/${id}`,
      baseRef: 'abc',
      createdAt: '2026-11-05T10:00:00Z',
      ticket: { source: ticket.source, id: ticket.id, title: 't' },
      ...over,
    });
    const main = wt(repo, 'main', true);

    it('lists a session, a manual branch with a worktree and a manual branch without a checkout', () => {
      const s = session('proj-1938-1');
      const work = workForTicket({
        ticket,
        repo,
        sessions: [s],
        branches: ['main', 'wb/proj-1938-1', 'feature/PROJ-1938-a', 'feat/proj-1938-b', 'unrelated'],
        worktrees: [main, wt(s.worktree, 'wb/proj-1938-1'), wt('/r/billing-api-proj-1938', 'feature/PROJ-1938-a')],
      });

      assert.deepEqual(work, [
        { branch: 'wb/proj-1938-1', worktree: s.worktree, session: s },
        { branch: 'feat/proj-1938-b', worktree: undefined, session: undefined },
        { branch: 'feature/PROJ-1938-a', worktree: '/r/billing-api-proj-1938', session: undefined },
      ]);
    });

    it('lists a session branch once even though its name also contains the key', () => {
      const s = session('proj-1938-1');
      const work = workForTicket({ ticket, repo, sessions: [s], branches: ['wb/proj-1938-1'], worktrees: [main] });
      assert.equal(work.length, 1);
      assert.equal(work[0].session, s);
    });

    it('returns only the sessions for a ticket without a key-shaped id', () => {
      const gh = { source: 'GitHub', id: '12' };
      const s = session('gh-12-1', { ticket: { source: 'GitHub', id: '12', title: 't' } });
      const work = workForTicket({
        ticket: gh,
        repo,
        sessions: [s],
        branches: ['fix/12-login', 'wb/gh-12-1'],
        worktrees: [main],
      });
      assert.deepEqual(work, [{ branch: 'wb/gh-12-1', worktree: s.worktree, session: s }]);
    });

    it('ignores sessions of other tickets and other repos', () => {
      const other = session('proj-1995-1', { ticket: { source: ticket.source, id: 'PROJ-1995', title: 't' } });
      const elsewhere = session('proj-1938-2', { repo: '/r/other-repo' });
      const work = workForTicket({ ticket, repo, sessions: [other, elsewhere], branches: [], worktrees: [main] });
      assert.deepEqual(work, []);
    });

    it('reports a branch checked out in the main working tree with that path', () => {
      const work = workForTicket({
        ticket,
        repo,
        sessions: [],
        branches: ['main', 'feature/PROJ-1938-a'],
        worktrees: [wt(repo, 'feature/PROJ-1938-a', true)],
      });
      assert.deepEqual(work, [{ branch: 'feature/PROJ-1938-a', worktree: repo, session: undefined }]);
    });

    it('returns nothing when nothing matches', () => {
      assert.deepEqual(workForTicket({ ticket, repo, sessions: [], branches: ['main'], worktrees: [main] }), []);
    });
  });

  describe('isTicketKey', () => {
    it('accepts Jira-style keys only', () => {
      for (const ok of ['PROJ-1938', 'abc-1', 'A1-22']) {
        assert.equal(isTicketKey(ok), true, ok);
      }
      for (const no of ['12', '#12', 'PROJ-', '-12', 'PROJ 12', '', 'PROJ-12a']) {
        assert.equal(isTicketKey(no), false, no);
      }
    });
  });
});
