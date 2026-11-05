import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverRepos } from '../../src/git/repos';
import { git } from '../../src/git/git';
import { createWorktree } from '../../src/git/worktree';
import { makeRepo } from './helpers/repo';

function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-repos-')));
}

async function initRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
}

describe('discoverRepos', () => {
  it('finds nothing without folders', async () => {
    assert.deepEqual(await discoverRepos([]), []);
  });

  it('treats a root that is a repo as the only repo, even with repos inside it', async () => {
    const root = tmpDir();
    await initRepo(root);
    await initRepo(path.join(root, 'nested'));
    const repos = await discoverRepos([root]);
    assert.deepEqual(repos, [{ root, name: path.basename(root), workspaceRoot: root }]);
  });

  it('resolves a root inside a repo to the repo top level', async () => {
    const top = tmpDir();
    await initRepo(top);
    const sub = path.join(top, 'src');
    fs.mkdirSync(sub);
    const repos = await discoverRepos([sub]);
    assert.deepEqual(repos.map((r) => r.root), [top]);
    assert.equal(repos[0].workspaceRoot, sub);
  });

  it('finds the direct subfolders with a .git directory, sorted by name', async () => {
    const parent = tmpDir();
    await initRepo(path.join(parent, 'b-repo'));
    await initRepo(path.join(parent, 'a-repo'));
    fs.mkdirSync(path.join(parent, 'plain'));
    fs.writeFileSync(path.join(parent, 'file.txt'), 'x');
    const repos = await discoverRepos([parent]);
    assert.deepEqual(
      repos.map((r) => [r.name, r.root, r.workspaceRoot]),
      [
        ['a-repo', path.join(parent, 'a-repo'), parent],
        ['b-repo', path.join(parent, 'b-repo'), parent],
      ],
    );
  });

  it('prefers child repos over an enclosing repo of the parent folder', async () => {
    const outer = tmpDir();
    await initRepo(outer);
    const parent = path.join(outer, 'harm');
    await initRepo(path.join(parent, 'one'));
    const repos = await discoverRepos([parent]);
    assert.deepEqual(repos.map((r) => r.root), [path.join(parent, 'one')]);
  });

  it('does not go deeper than one level', async () => {
    const parent = tmpDir();
    await initRepo(path.join(parent, 'group', 'deep'));
    assert.deepEqual(await discoverRepos([parent]), []);
  });

  it('skips session worktrees, which have a .git file and live next to the repo', async () => {
    const { parent, repo } = await makeRepo();
    await createWorktree({ repo, slug: 'gh-1-1', baseRef: 'main' });
    assert.ok(fs.existsSync(path.join(`${repo}.worktrees`, 'gh-1-1', '.git')));
    const repos = await discoverRepos([parent]);
    assert.deepEqual(repos.map((r) => r.root), [repo]);
  });

  it('merges several workspace folders and drops duplicates', async () => {
    const parent = tmpDir();
    await initRepo(path.join(parent, 'one'));
    await initRepo(path.join(parent, 'two'));
    const repos = await discoverRepos([parent, path.join(parent, 'one')]);
    assert.deepEqual(repos.map((r) => r.name), ['one', 'two']);
  });

  it('ignores folders that do not exist', async () => {
    assert.deepEqual(await discoverRepos([path.join(tmpDir(), 'missing')]), []);
  });
});
