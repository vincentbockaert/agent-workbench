import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../src/git/git';
import { changedFiles, createWorktree, removeWorktree } from '../../src/git/worktree';

// Real git against throwaway repos: no mocks.
async function makeRepo(): Promise<{ parent: string; repo: string }> {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-')));
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  // Local config only, so the user's global signing/identity settings don't affect tests.
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(repo, 'edit.txt'), 'before\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'gone\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return { parent, repo };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-q', '-m', message]);
}

describe('worktree', function () {
  this.timeout(20000);
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  describe('createWorktree', () => {
    it('creates the worktree next to the repo, outside it, on branch wb/<slug>', async () => {
      const wt = await createWorktree({ repo, slug: 'proj-123-1', baseRef: 'main' });

      assert.equal(wt.path, path.join(parent, 'repo.worktrees', 'proj-123-1'));
      assert.equal(wt.branch, 'wb/proj-123-1');
      assert.ok(!wt.path.startsWith(repo + path.sep), 'worktree must not live inside the repo');
      assert.ok(fs.existsSync(path.join(wt.path, 'keep.txt')));
      assert.equal((await git(wt.path, ['branch', '--show-current'])).trim(), 'wb/proj-123-1');
    });

    it('honours a custom root folder', async () => {
      const root = path.join(parent, 'elsewhere');
      const wt = await createWorktree({ repo, slug: 'a', baseRef: 'main', root });
      assert.equal(wt.path, path.join(root, 'a'));
    });

    it('leaves the main working tree untouched', async () => {
      const wt = await createWorktree({ repo, slug: 'iso', baseRef: 'main' });
      fs.writeFileSync(path.join(wt.path, 'edit.txt'), 'agent change\n');

      assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '');
      assert.equal((await git(repo, ['branch', '--show-current'])).trim(), 'main');
    });

    it('rejects a slug that is already used', async () => {
      await createWorktree({ repo, slug: 'dup', baseRef: 'main' });
      await assert.rejects(createWorktree({ repo, slug: 'dup', baseRef: 'main' }), /already exists/);
    });

    it('rejects slugs that are not lowercase letters, digits, dots, dashes or underscores', async () => {
      for (const slug of ['', 'Has Space', '../escape', 'a/b', 'UPPER']) {
        await assert.rejects(createWorktree({ repo, slug, baseRef: 'main' }), /invalid slug/i, `slug "${slug}"`);
      }
    });

    it('fails clearly for an unknown base ref', async () => {
      await assert.rejects(createWorktree({ repo, slug: 'x', baseRef: 'no-such-branch' }), /no-such-branch/);
    });
  });

  describe('changedFiles', () => {
    it('is empty for a fresh worktree', async () => {
      const wt = await createWorktree({ repo, slug: 'fresh', baseRef: 'main' });
      assert.deepEqual(await changedFiles(wt.path, 'main'), []);
    });

    it('reports committed and uncommitted changes since the base, sorted by path', async () => {
      const wt = await createWorktree({ repo, slug: 'work', baseRef: 'main' });
      // Committed on the session branch.
      fs.writeFileSync(path.join(wt.path, 'edit.txt'), 'after\n');
      fs.rmSync(path.join(wt.path, 'gone.txt'));
      fs.mkdirSync(path.join(wt.path, 'src'));
      fs.writeFileSync(path.join(wt.path, 'src', 'new.ts'), 'export {};\n');
      await commitAll(wt.path, 'agent work');
      // Uncommitted: a staged-less edit and an untracked file.
      fs.writeFileSync(path.join(wt.path, 'keep.txt'), 'changed but not committed\n');
      fs.writeFileSync(path.join(wt.path, 'scratch.md'), 'notes\n');

      assert.deepEqual(await changedFiles(wt.path, 'main'), [
        { path: 'edit.txt', status: 'modified' },
        { path: 'gone.txt', status: 'deleted' },
        { path: 'keep.txt', status: 'modified' },
        { path: 'scratch.md', status: 'untracked' },
        { path: 'src/new.ts', status: 'added' },
      ]);
    });

    it('ignores commits made on the base branch after the worktree was created', async () => {
      const wt = await createWorktree({ repo, slug: 'diverged', baseRef: 'main' });
      fs.writeFileSync(path.join(repo, 'keep.txt'), 'changed on main\n');
      await commitAll(repo, 'main moves on');

      assert.deepEqual(await changedFiles(wt.path, 'main'), []);
    });

    it('does not report files ignored by .gitignore', async () => {
      fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
      await commitAll(repo, 'ignore dist');
      const wt = await createWorktree({ repo, slug: 'ign', baseRef: 'main' });
      fs.mkdirSync(path.join(wt.path, 'dist'));
      fs.writeFileSync(path.join(wt.path, 'dist', 'out.js'), '');

      assert.deepEqual(await changedFiles(wt.path, 'main'), []);
    });
  });

  describe('removeWorktree', () => {
    it('removes a clean worktree but keeps its branch', async () => {
      const wt = await createWorktree({ repo, slug: 'done', baseRef: 'main' });
      await removeWorktree(repo, wt.path);

      assert.ok(!fs.existsSync(wt.path));
      assert.match(await git(repo, ['branch', '--list', 'wb/done']), /wb\/done/);
    });

    it('refuses to remove a worktree with uncommitted changes unless forced', async () => {
      const wt = await createWorktree({ repo, slug: 'dirty', baseRef: 'main' });
      fs.writeFileSync(path.join(wt.path, 'edit.txt'), 'unsaved work\n');

      await assert.rejects(removeWorktree(repo, wt.path), /uncommitted|modified|untracked/i);
      assert.ok(fs.existsSync(wt.path));

      await removeWorktree(repo, wt.path, { force: true });
      assert.ok(!fs.existsSync(wt.path));
    });
  });
});
