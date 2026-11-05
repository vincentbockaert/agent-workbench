import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../src/git/git';
import type { RepoInfo } from '../../src/git/repos';
import { manualBranchesForTicket, WorkIndex } from '../../src/tickets/workIndex';
import { makeRepo } from './helpers/repo';

const info = (root: string): RepoInfo => ({ root, name: path.basename(root), workspaceRoot: path.dirname(root) });

describe('work index', function () {
  this.timeout(20000);
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature/PROJ-7-a', path.join(parent, 'repo-proj-7')]);
    await git(repo, ['branch', 'feat/proj-7-b']);
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('reads branches, worktrees and the base of every repo', async () => {
    const index = new WorkIndex(() => [info(repo)]);
    const [w] = await index.ensure();

    assert.equal(w.repo.root, repo);
    assert.equal(w.baseRef, 'main');
    assert.deepEqual(w.branches.sort(), ['feat/proj-7-b', 'feature/PROJ-7-a', 'main']);
    assert.equal(w.worktrees.length, 2);
  });

  it('peek is undefined until the repos are read, then returns them', async () => {
    const index = new WorkIndex(() => [info(repo)]);
    assert.equal(index.peek(), undefined);
    await index.ensure();
    assert.equal(index.peek()?.length, 1);
  });

  it('keeps reading cached data until invalidated', async () => {
    const index = new WorkIndex(() => [info(repo)]);
    await index.ensure();
    await git(repo, ['branch', 'proj-7-late']);

    assert.equal((await index.ensure())[0].branches.includes('proj-7-late'), false);
    index.invalidate();
    assert.equal(index.peek(), undefined);
    assert.equal((await index.ensure())[0].branches.includes('proj-7-late'), true);
  });

  it('invalidates a single repo and keeps the others', async () => {
    const other = await makeRepo();
    try {
      const index = new WorkIndex(() => [info(repo), info(other.repo)]);
      await index.ensure();
      await git(repo, ['branch', 'new-a']);
      await git(other.repo, ['branch', 'new-b']);

      index.invalidate(repo);
      const all = await index.ensure();
      assert.equal(all.find((w) => w.repo.root === repo)?.branches.includes('new-a'), true);
      assert.equal(all.find((w) => w.repo.root === other.repo)?.branches.includes('new-b'), false);
    } finally {
      fs.rmSync(other.parent, { recursive: true, force: true });
    }
  });

  it('leaves out a repo that cannot be read', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nogit-'));
    try {
      const index = new WorkIndex(() => [info(broken), info(repo)]);
      const all = await index.ensure();
      assert.deepEqual(all.map((w) => w.repo.root), [repo]);
      assert.equal(index.peek()?.length, 1);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  it('never runs more reads at once than the concurrency cap', async () => {
    const repos = await Promise.all([0, 1, 2, 3, 4].map(() => makeRepo()));
    try {
      let running = 0;
      let peak = 0;
      const index = new WorkIndex(() => repos.map((r) => info(r.repo)), 2, async (read) => {
        running++;
        peak = Math.max(peak, running);
        try {
          return await read();
        } finally {
          running--;
        }
      });
      assert.equal((await index.ensure()).length, 5);
      assert.ok(peak <= 2, `peak was ${peak}`);
    } finally {
      repos.forEach((r) => fs.rmSync(r.parent, { recursive: true, force: true }));
    }
  });

  describe('manualBranchesForTicket', () => {
    it('collects key-matching branches of every repo, with their checkouts and base', async () => {
      const index = new WorkIndex(() => [info(repo)]);
      const found = manualBranchesForTicket(await index.ensure(), { source: 'Jira PROJ', id: 'PROJ-7' }, []);

      assert.deepEqual(
        found.map((m) => [m.branch, m.worktree && path.basename(m.worktree), m.baseRef]),
        [
          ['feat/proj-7-b', undefined, 'main'],
          ['feature/PROJ-7-a', 'repo-proj-7', 'main'],
        ],
      );
      assert.equal(found[0].repo.root, repo);
    });

    it('is empty for a ticket nothing matches', async () => {
      const index = new WorkIndex(() => [info(repo)]);
      assert.deepEqual(manualBranchesForTicket(await index.ensure(), { source: 'Jira PROJ', id: 'PROJ-8' }, []), []);
    });
  });
});
