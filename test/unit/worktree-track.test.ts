import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { git } from '../../src/git/git';
import { createWorktree } from '../../src/git/worktree';
import { makeRepo } from './helpers/repo';

describe('createWorktree from a remote-tracking branch', () => {
  let parent: string;
  let repo: string;
  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
    const remote = path.join(parent, 'remote.git');
    await git(parent, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await git(repo, ['push', '-q', 'origin', 'main']);
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  const upstream = async (branch: string) => {
    try {
      return (await git(repo, ['config', '--get', `branch.${branch}.merge`])).trim();
    } catch {
      return undefined;
    }
  };

  it('does not make the new branch track the base, so a later pull or push cannot touch origin/main by accident', async () => {
    const wt = await createWorktree({ repo, slug: 's-1', baseRef: 'origin/main' });
    assert.equal(wt.branch, 'wb/s-1');
    assert.equal(await upstream('wb/s-1'), undefined);
  });

  it('starts at exactly the commit of the chosen base', async () => {
    const wt = await createWorktree({ repo, slug: 's-2', baseRef: 'origin/main' });
    assert.equal((await git(wt.path, ['rev-parse', 'HEAD'])).trim(), (await git(repo, ['rev-parse', 'origin/main'])).trim());
  });
});
