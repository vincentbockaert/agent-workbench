import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { changedFilesForBranch, changesForTarget, diffStatsForBranch, targetMergeBase } from '../../src/git/branchdiff';
import { git } from '../../src/git/git';
import { commitAll, makeRepo } from './helpers/repo';

describe('branchdiff', function () {
  this.timeout(20000);
  let parent: string;
  let repo: string;

  // A branch (not checked out afterwards) with an added, a modified and a deleted file; main moves on after it branched.
  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
    await git(repo, ['checkout', '-q', '-b', 'feature/HDO-1-x']);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'after\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    await commitAll(repo, 'work');
    await git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'later\n');
    await commitAll(repo, 'main moved on');
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  describe('changedFilesForBranch', () => {
    it('lists the branch changes since it left the base, not what the base gained later', async () => {
      assert.deepEqual(await changedFilesForBranch(repo, 'feature/HDO-1-x', 'main'), [
        { path: 'edit.txt', status: 'modified' },
        { path: 'gone.txt', status: 'deleted' },
        { path: 'new.txt', status: 'added' },
      ]);
    });

    it('is empty for a branch with no commits of its own', async () => {
      await git(repo, ['branch', 'empty']);
      assert.deepEqual(await changedFilesForBranch(repo, 'empty', 'main'), []);
    });

    it('rejects an unknown branch', async () => {
      await assert.rejects(changedFilesForBranch(repo, 'nope', 'main'));
    });
  });

  describe('diffStatsForBranch', () => {
    it('counts added and removed lines per path', async () => {
      const stats = await diffStatsForBranch(repo, 'feature/HDO-1-x', 'main');
      assert.deepEqual(stats.get('new.txt'), { added: 2, removed: 0 });
      assert.deepEqual(stats.get('edit.txt'), { added: 1, removed: 1 });
      assert.deepEqual(stats.get('gone.txt'), { added: 0, removed: 1 });
      assert.equal(stats.has('main-only.txt'), false);
    });

    it('leaves binary files out', async () => {
      await git(repo, ['checkout', '-q', 'feature/HDO-1-x']);
      fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
      await commitAll(repo, 'binary');
      await git(repo, ['checkout', '-q', 'main']);

      const stats = await diffStatsForBranch(repo, 'feature/HDO-1-x', 'main');
      assert.equal(stats.has('blob.bin'), false);
      assert.ok(stats.has('new.txt'));
    });
  });

  describe('changesForTarget and targetMergeBase', () => {
    it('without a worktree: committed changes, read from the repo', async () => {
      const { files, stats } = await changesForTarget({ repo, branch: 'feature/HDO-1-x', baseRef: 'main' });
      assert.deepEqual(files.map((f) => f.path), ['edit.txt', 'gone.txt', 'new.txt']);
      assert.deepEqual(stats.get('new.txt'), { added: 2, removed: 0 });
    });

    it('with a worktree: also uncommitted and untracked work', async () => {
      const worktree = path.join(parent, 'repo-hdo-1');
      await git(repo, ['worktree', 'add', '-q', worktree, 'feature/HDO-1-x']);
      fs.writeFileSync(path.join(worktree, 'edit.txt'), 'after\nby hand\n');
      fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'x\n');

      const { files, stats } = await changesForTarget({ repo, branch: 'feature/HDO-1-x', baseRef: 'main', worktree });
      assert.deepEqual(files.map((f) => [f.path, f.status]), [
        ['edit.txt', 'modified'],
        ['gone.txt', 'deleted'],
        ['new.txt', 'added'],
        ['scratch.txt', 'untracked'],
      ]);
      assert.deepEqual(stats.get('edit.txt'), { added: 2, removed: 1 });
    });

    it('targetMergeBase is the commit the branch left the base at, with or without a worktree', async () => {
      const expected = (await git(repo, ['merge-base', 'main', 'feature/HDO-1-x'])).trim();
      const worktree = path.join(parent, 'repo-hdo-1');
      await git(repo, ['worktree', 'add', '-q', worktree, 'feature/HDO-1-x']);

      assert.equal(await targetMergeBase({ repo, branch: 'feature/HDO-1-x', baseRef: 'main' }), expected);
      assert.equal(await targetMergeBase({ repo, branch: 'feature/HDO-1-x', baseRef: 'main', worktree }), expected);
    });
  });
});
