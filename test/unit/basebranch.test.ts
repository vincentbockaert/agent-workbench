import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BaseChoice, describeBase, listBaseChoices, resolveBase } from '../../src/git/basebranch';
import { git } from '../../src/git/git';
import { createWorktree } from '../../src/git/worktree';
import { makeRepo } from './helpers/repo';

// Commits with a given committer date, so "most recently updated first" is deterministic.
// The repo's own local config supplies the identity and turns signing off.
async function commitOn(cwd: string, file: string, date: string): Promise<void> {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  await git(cwd, ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', file], { cwd, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
}

describe('listBaseChoices', () => {
  let parent: string;
  let repo: string;
  beforeEach(async () => ({ parent, repo } = await makeRepo()));
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  const refs = async () => (await listBaseChoices(repo)).map((c) => c.ref);

  it('offers just the default branch in a fresh repo, and marks it default and current', async () => {
    const [only, ...rest] = await listBaseChoices(repo);
    assert.deepEqual(rest, []);
    assert.deepEqual([only.ref, only.isDefault, only.isCurrent, only.kind], ['main', true, true, 'local']);
  });

  it('puts the default branch first, then the branch checked out in the main folder, then the rest by last commit', async () => {
    await git(repo, ['branch', 'older']);
    await git(repo, ['checkout', '-q', '-b', 'newer']);
    await commitOn(repo, 'n.txt', '2099-01-01T10:00:00Z');
    await git(repo, ['checkout', '-q', '-b', 'middle', 'main']);
    await commitOn(repo, 'm.txt', '2098-01-01T10:00:00Z');
    await git(repo, ['checkout', '-q', '-b', 'current-one', 'main']);
    const choices = await listBaseChoices(repo);
    assert.deepEqual(choices.map((c) => c.ref), ['main', 'current-one', 'newer', 'middle', 'older']);
    assert.deepEqual(choices.find((c) => c.ref === 'current-one')!.isCurrent, true);
    assert.equal(choices.find((c) => c.ref === 'main')!.isCurrent, false);
  });

  it('flags a branch that another worktree has checked out, with that worktree\'s path', async () => {
    const other = path.join(parent, 'other-wt');
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', other, 'main']);
    const feature = (await listBaseChoices(repo)).find((c) => c.ref === 'feature')!;
    assert.equal(feature.worktree, fs.realpathSync.native(other));
    assert.equal(feature.isSession, false);
  });

  it('flags the branch of a workbench session as such', async () => {
    const wt = await createWorktree({ repo, slug: 'jira-1-1', baseRef: 'main' });
    const session = (await listBaseChoices(repo)).find((c) => c.ref === 'wb/jira-1-1')!;
    assert.equal(session.isSession, true);
    assert.equal(session.worktree, fs.realpathSync.native(wt.path));
  });

  it('does not flag the main working tree\'s own branch as "another worktree"', async () => {
    assert.equal((await listBaseChoices(repo)).find((c) => c.ref === 'main')!.worktree, undefined);
  });

  it('has no current branch when the main folder is on a detached HEAD', async () => {
    await git(repo, ['checkout', '-q', '--detach']);
    assert.ok((await listBaseChoices(repo)).every((c) => !c.isCurrent));
  });

  describe('with a remote', () => {
    beforeEach(async () => {
      const remote = path.join(parent, 'remote.git');
      await git(parent, ['init', '-q', '--bare', '-b', 'main', remote]);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['push', '-q', 'origin', 'main']);
      await git(repo, ['remote', 'set-head', 'origin', 'main']);
    });

    it('lists the remote default first, then the local one', async () => {
      const choices = await listBaseChoices(repo);
      assert.deepEqual(choices.slice(0, 2).map((c) => [c.ref, c.kind, c.isDefault]), [['origin/main', 'remote', true], ['main', 'local', true]]);
      assert.equal(choices.filter((c) => c.ref === 'origin/main').length, 1);
    });

    it('says how old the remote default is', async () => {
      assert.match((await listBaseChoices(repo))[0].updated ?? '', /ago|now/);
    });

    it('does not list other remote branches', async () => {
      await git(repo, ['push', '-q', 'origin', 'main:refs/heads/someone-elses']);
      await git(repo, ['fetch', '-q', 'origin']);
      assert.ok(!(await refs()).includes('origin/someone-elses'));
    });
  });

  it('works for a repo that is itself a linked worktree, without calling its own branch "another worktree"', async () => {
    const linked = path.join(parent, 'linked');
    await git(repo, ['worktree', 'add', '-q', '-b', 'mine', linked, 'main']);
    const choices = await listBaseChoices(linked);
    assert.equal(choices.find((c) => c.ref === 'mine')!.worktree, undefined);
    assert.equal(choices.find((c) => c.ref === 'mine')!.isCurrent, true);
  });
});

describe('resolveBase', () => {
  const choice = (ref: string, extra: Partial<BaseChoice> = {}): BaseChoice => ({ ref, kind: 'local', isDefault: false, isCurrent: false, isSession: false, ...extra });
  const choices = [choice('origin/main', { kind: 'remote', isDefault: true }), choice('main', { isDefault: true }), choice('feature', { isCurrent: true }), choice('other')];

  it('asks, offering every choice, in "ask" mode', () => {
    assert.deepEqual(resolveBase('ask', choices), { ask: choices });
  });

  it('takes the default branch without asking in "default-branch" mode', () => {
    assert.deepEqual(resolveBase('default-branch', choices), { ref: 'origin/main' });
  });

  it('takes the branch checked out in the repo folder in "current" mode (the old behaviour)', () => {
    assert.deepEqual(resolveBase('current', choices), { ref: 'feature' });
  });

  it('asks instead when the mode cannot be honoured: no default branch, or a detached HEAD', () => {
    const noDefault = [choice('feature', { isCurrent: true })];
    assert.deepEqual(resolveBase('default-branch', noDefault), { ask: noDefault });
    const detached = [choice('main', { isDefault: true })];
    assert.deepEqual(resolveBase('current', detached), { ask: detached });
  });

  it('reports a repository with no branch at all', () => {
    assert.deepEqual(resolveBase('ask', []), { error: 'This repository has no branch to start from; make a first commit.' });
  });

  it('treats an unknown mode as "ask"', () => {
    assert.deepEqual(resolveBase('whatever' as never, choices), { ask: choices });
  });
});

describe('describeBase', () => {
  const choice = (ref: string, extra: Partial<BaseChoice> = {}): BaseChoice => ({ ref, kind: 'local', isDefault: false, isCurrent: false, isSession: false, ...extra });

  it('labels the default branch and says how old a remote-tracking one is', () => {
    const d = describeBase(choice('origin/main', { kind: 'remote', isDefault: true, updated: '3 days ago' }));
    assert.deepEqual([d.label, d.description], ['origin/main', 'default · remote, as of your last fetch · 3 days ago']);
    assert.equal(d.warning, undefined);
  });

  it('marks the branch checked out in the repo folder', () => {
    assert.match(describeBase(choice('feature', { isCurrent: true })).description, /checked out here/);
  });

  it('warns about a branch another worktree has checked out, naming the folder', () => {
    const d = describeBase(choice('feature', { worktree: '/w/other' }));
    assert.match(d.warning ?? '', /\/w\/other/);
    assert.match(d.warning ?? '', /uncommitted/);
  });

  it('warns once, naming both, for a session branch that is checked out in its session folder', () => {
    const w = describeBase(choice('wb/jira-1-1', { isSession: true, worktree: '/w/s' })).warning ?? '';
    assert.match(w, /session/i);
    assert.match(w, /\/w\/s/);
    assert.match(w, /uncommitted/);
  });

  it('warns about a session branch', () => {
    assert.match(describeBase(choice('wb/jira-1-1', { isSession: true })).warning ?? '', /session/i);
  });
});
