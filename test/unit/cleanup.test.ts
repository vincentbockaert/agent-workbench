import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { blockers, describeCandidate, isOnBase, isPushed, prReason, removalCandidates } from '../../src/sessions/cleanup';
import { git } from '../../src/git/git';
import { createWorktree } from '../../src/git/worktree';
import type { PullRequest } from '../../src/pr/model';
import type { Session } from '../../src/sessions/model';
import type { CleanupCandidate, CleanupReason } from '../../src/sessions/cleanup';
import { commitAll, makeRepo } from './helpers/repo';

const DAY = 86_400_000;

function pr(over: Partial<PullRequest>): PullRequest {
  return {
    repo: 'repo',
    repoRoot: '/r',
    number: 1,
    title: 't',
    url: 'u',
    state: 'open',
    branch: 'wb/x-1',
    base: 'main',
    updatedAt: '2026-01-01T00:00:00Z',
    review: 'none',
    checks: 'none',
    conflicts: false,
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return { id: 'x-1', repo: '/r', worktree: '/r/wt', branch: 'wb/x-1', baseRef: 'main', createdAt: '2026-01-01T00:00:00Z', ...over };
}

describe('session cleanup', function () {
  this.timeout(30000);
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  // A real session: worktree + branch wb/<slug>, with one commit of its own unless `commit` is false.
  async function newSession(slug: string, opts: { commit?: boolean; createdAt?: string } = {}): Promise<Session> {
    const wt = await createWorktree({ repo, slug, baseRef: 'main', root: path.join(parent, 'wts') });
    if (opts.commit !== false) {
      fs.writeFileSync(path.join(wt.path, `${slug}.txt`), 'work\n');
      await commitAll(wt.path, `work ${slug}`);
    }
    return { id: slug, repo, worktree: wt.path, branch: wt.branch, baseRef: 'main', createdAt: opts.createdAt ?? new Date(Date.now() - 3_600_000).toISOString() };
  }

  async function addOrigin(): Promise<void> {
    const bare = path.join(parent, 'origin.git');
    await git(parent, ['init', '-q', '--bare', bare]);
    await git(repo, ['remote', 'add', 'origin', bare]);
    await git(repo, ['push', '-q', 'origin', 'main']);
  }

  describe('isOnBase', () => {
    it('is true once the branch is merged into the base, false while it has its own commits', async () => {
      const s = await newSession('a-1');
      assert.equal(await isOnBase(repo, s.branch, 'main'), false);
      await git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', s.branch]);
      assert.equal(await isOnBase(repo, s.branch, 'main'), true);
    });

    it('is false for a missing ref instead of throwing', async () => {
      assert.equal(await isOnBase(repo, 'wb/nope', 'main'), false);
      assert.equal(await isOnBase(repo, 'main', 'nope'), false);
    });
  });

  describe('isPushed', () => {
    it('is true when origin has all commits, false with a commit ahead or without a remote branch', async () => {
      const s = await newSession('b-1');
      assert.equal(await isPushed(repo, s.branch), false); // no remote at all
      await addOrigin();
      assert.equal(await isPushed(repo, s.branch), false); // remote exists, branch not pushed
      await git(repo, ['push', '-q', 'origin', s.branch]);
      assert.equal(await isPushed(repo, s.branch), true);
      fs.writeFileSync(path.join(s.worktree, 'more.txt'), 'more\n');
      await commitAll(s.worktree, 'more');
      assert.equal(await isPushed(repo, s.branch), false);
    });
  });

  describe('prReason', () => {
    const s = session({ repo: '/r' });
    it('reports merged, closed, open (draft counts as open) or none', () => {
      assert.equal(prReason(s, [pr({ state: 'merged' })]), 'merged');
      assert.equal(prReason(s, [pr({ state: 'closed' })]), 'closed');
      assert.equal(prReason(s, [pr({ state: 'open' })]), 'open');
      assert.equal(prReason(s, [pr({ state: 'draft' })]), 'open');
      assert.equal(prReason(s, []), 'none');
    });
    it('lets an open PR win over an older closed one, and merged over closed', () => {
      assert.equal(prReason(s, [pr({ state: 'closed' }), pr({ number: 2, state: 'open' })]), 'open');
      assert.equal(prReason(s, [pr({ state: 'closed' }), pr({ number: 2, state: 'merged' })]), 'merged');
    });
    it('ignores a same-named branch of another repo or another branch', () => {
      assert.equal(prReason(s, [pr({ state: 'merged', repoRoot: '/other' })]), 'none');
      assert.equal(prReason(s, [pr({ state: 'merged', branch: 'wb/y-1' })]), 'none');
    });
  });

  describe('blockers', () => {
    it('is empty for a clean tree and when only .workbench/ is untracked', async () => {
      const s = await newSession('c-1');
      assert.deepEqual(await blockers(s), []);
      fs.mkdirSync(path.join(s.worktree, '.workbench'));
      fs.writeFileSync(path.join(s.worktree, '.workbench', 'TASK.md'), 'x\n');
      assert.deepEqual(await blockers(s), []);
    });
    it('reports edited and untracked files', async () => {
      const s = await newSession('c-2');
      fs.writeFileSync(path.join(s.worktree, 'edit.txt'), 'changed\n');
      fs.writeFileSync(path.join(s.worktree, 'new.txt'), 'new\n');
      const b = await blockers(s);
      assert.equal(b.length, 1);
      assert.match(b[0], /uncommitted/i);
      assert.match(b[0], /edit\.txt/);
      assert.match(b[0], /new\.txt/);
    });
    it('is empty when the worktree folder is already gone', async () => {
      assert.deepEqual(await blockers(session({ worktree: path.join(parent, 'missing') })), []);
    });
  });

  describe('removalCandidates', () => {
    const now = () => new Date();
    const one = async (s: Session, prs: PullRequest[] = [], at = now()) => {
      const [c] = await removalCandidates([s], prs, at);
      return c;
    };

    it('suggests a clean session whose branch was merged', async () => {
      const s = await newSession('d-1');
      await git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', s.branch]);
      const c = await one(s);
      assert.ok(c.reasons.includes('on-base'));
      assert.equal(c.suggested, true);
      assert.deepEqual(c.blockers, []);
    });

    it('suggests a squash-merged session through its merged PR, and a closed one', async () => {
      const s = await newSession('d-2');
      const pull = (state: PullRequest['state']) => pr({ state, repoRoot: repo, branch: s.branch });
      const merged = await one(s, [pull('merged')]);
      assert.ok(merged.reasons.includes('pr-merged'));
      assert.equal(merged.suggested, true);
      const closed = await one(s, [pull('closed')]);
      assert.ok(closed.reasons.includes('pr-closed'));
      assert.equal(closed.suggested, true);
    });

    it('lists but does not suggest a pushed branch with an open PR', async () => {
      const s = await newSession('d-3');
      await addOrigin();
      await git(repo, ['push', '-q', 'origin', s.branch]);
      const c = await one(s, [pr({ state: 'open', repoRoot: repo, branch: s.branch })]);
      assert.ok(c.reasons.includes('pushed'));
      assert.equal(c.suggested, false);
    });

    it('flags commits that exist only on this machine', async () => {
      const s = await newSession('d-4');
      const c = await one(s);
      assert.deepEqual(c.reasons, ['local-only']);
      assert.equal(c.suggested, false);
    });

    it('never suggests a fresh session without commits (it is trivially "on base")', async () => {
      const s = await newSession('d-5', { commit: false, createdAt: new Date(Date.now() + 60_000).toISOString() });
      const c = await one(s);
      assert.ok(c.reasons.includes('empty'));
      assert.ok(!c.reasons.includes('on-base'));
      assert.equal(c.suggested, false);
    });

    it('blocks a dirty session whatever the PR says', async () => {
      const s = await newSession('d-6');
      fs.writeFileSync(path.join(s.worktree, 'edit.txt'), 'changed\n');
      const c = await one(s, [pr({ state: 'merged', repoRoot: repo, branch: s.branch })]);
      assert.ok(c.reasons.includes('pr-merged'));
      assert.equal(c.blockers.length, 1);
      assert.equal(c.suggested, false);
    });

    it('lists a session idle for 14+ days, without suggesting it', async () => {
      const s = await newSession('d-7');
      const c = await one(s, [], new Date(Date.now() + 15 * DAY));
      assert.ok(c.reasons.includes('idle'));
      assert.equal(c.suggested, false);
    });
  });
});

describe('describeCandidate', () => {
  const cand = (reasons: CleanupReason[], blockers: string[] = [], suggested = false): CleanupCandidate => ({ session: session(), reasons, blockers, suggested });

  it('words the strongest reason, with a hint only for suggested sessions', () => {
    assert.deepEqual(describeCandidate(cand(['pr-merged', 'pushed'], [], true)), { text: 'PR merged, pushed', hint: 'PR merged: can be removed' });
    assert.equal(describeCandidate(cand(['pr-closed'], [], true)).hint, 'PR closed: can be removed');
    assert.equal(describeCandidate(cand(['on-base'], [], true)).hint, 'merged: can be removed');
  });
  it('gives no hint for reasons that are only listed on demand', () => {
    for (const r of ['pushed', 'idle', 'empty', 'local-only'] as const) {
      assert.equal(describeCandidate(cand([r])).hint, undefined, r);
    }
    assert.equal(describeCandidate(cand(['pushed', 'idle'])).text, 'pushed, idle');
    assert.equal(describeCandidate(cand(['local-only'])).text, 'commits only on this machine');
  });
  it('says why a blocked session stays, and gives no hint', () => {
    const d = describeCandidate(cand(['pr-merged'], ['uncommitted changes: a.txt']));
    assert.equal(d.hint, undefined);
    assert.match(d.text, /PR merged/);
    assert.match(d.text, /uncommitted changes/);
  });
});
