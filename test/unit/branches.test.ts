import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { defaultBranch, listLocalBranches, listWorktrees } from '../../src/git/branches';
import { git } from '../../src/git/git';
import { makeRepo } from './helpers/repo';

describe('branches', function () {
  this.timeout(20000);
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  describe('listWorktrees', () => {
    it('lists only the main working tree for a plain repo', async () => {
      const list = await listWorktrees(repo);
      assert.equal(list.length, 1);
      assert.equal(list[0].path, repo);
      assert.equal(list[0].branch, 'main');
      assert.equal(list[0].main, true);
      assert.equal(list[0].detached, false);
      assert.match(list[0].head, /^[0-9a-f]{40}$/);
    });

    it('lists linked worktrees with short branch names, including slashes', async () => {
      const wt = path.join(parent, 'repo-hdo-1938');
      await git(repo, ['worktree', 'add', '-q', '-b', 'feature/HDO-1938-x', wt]);

      const list = await listWorktrees(repo);
      assert.equal(list.length, 2);
      assert.equal(list[1].path, wt);
      assert.equal(list[1].branch, 'feature/HDO-1938-x');
      assert.equal(list[1].main, false);
    });

    it('marks a detached worktree without a branch', async () => {
      const wt = path.join(parent, 'detached');
      await git(repo, ['worktree', 'add', '-q', '--detach', wt]);

      const entry = (await listWorktrees(repo)).find((w) => w.path === wt);
      assert.ok(entry);
      assert.equal(entry.detached, true);
      assert.equal(entry.branch, undefined);
    });

    it('gives the same answer when asked from inside a linked worktree', async () => {
      const wt = path.join(parent, 'linked');
      await git(repo, ['worktree', 'add', '-q', '-b', 'b1', wt]);

      const fromRepo = await listWorktrees(repo);
      const fromLinked = await listWorktrees(wt);
      assert.deepEqual(fromLinked, fromRepo);
    });
  });
  describe('defaultBranch', () => {
    it('prefers origin/HEAD when the remote has one', async () => {
      const remote = path.join(parent, 'remote.git');
      await git(parent, ['clone', '-q', '--bare', repo, remote]);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['fetch', '-q', 'origin']);
      await git(repo, ['remote', 'set-head', 'origin', 'main']);

      assert.equal(await defaultBranch(repo), 'origin/main');
    });

    it('falls back to local main, then master', async () => {
      assert.equal(await defaultBranch(repo), 'main');

      await git(repo, ['branch', '-m', 'main', 'master']);
      assert.equal(await defaultBranch(repo), 'master');
    });

    it('is undefined when there is no main, master or origin/HEAD', async () => {
      await git(repo, ['branch', '-m', 'main', 'trunk']);
      assert.equal(await defaultBranch(repo), undefined);
    });
  });

  describe('listLocalBranches', () => {
    it('lists local branches only, including slashed names', async () => {
      await git(repo, ['branch', 'feature/HDO-1938-x']);
      await git(repo, ['branch', 'wb/proj-1-1']);

      assert.deepEqual((await listLocalBranches(repo)).sort(), ['feature/HDO-1938-x', 'main', 'wb/proj-1-1']);
    });

    it('does not list remote-tracking branches', async () => {
      const remote = path.join(parent, 'remote.git');
      await git(parent, ['clone', '-q', '--bare', repo, remote]);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['fetch', '-q', 'origin']);

      assert.deepEqual(await listLocalBranches(repo), ['main']);
    });
  });
});
