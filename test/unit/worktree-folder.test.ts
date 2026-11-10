import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import manifest from '../../package.json';
import { discoverRepos } from '../../src/git/repos';
import { createWorktree, worktreeRootFor } from '../../src/git/worktree';
import { deleteSession, startSession } from '../../src/sessions/lifecycle';
import { SessionStore } from '../../src/sessions/store';
import { makeRepo } from './helpers/repo';

const HOME = path.join(path.sep, 'home', 'me');
const REPO = path.join(path.sep, 'src', 'harm', 'argocd');

describe('worktree folder', function () {
  this.timeout(20000);

  describe('worktreeRootFor', () => {
    it('defaults to one hidden folder next to the repos, with a subfolder per repo', () => {
      for (const setting of [undefined, '', '  ']) {
        assert.equal(worktreeRootFor(REPO, setting, HOME), path.join(path.sep, 'src', 'harm', '.worktrees', 'argocd'));
      }
    });

    it('fills {parent} and {repo}, so the old sibling layout is one setting away', () => {
      assert.equal(worktreeRootFor(REPO, '{parent}/{repo}.worktrees', HOME), path.join(path.sep, 'src', 'harm', 'argocd.worktrees'));
    });

    it('expands ~ and adds the repo name when the setting does not place it', () => {
      assert.equal(worktreeRootFor(REPO, '~/.cache/wb', HOME), path.join(HOME, '.cache', 'wb', 'argocd'));
      assert.equal(worktreeRootFor(REPO, '/var/wt/{repo}-trees', HOME), path.join(path.sep, 'var', 'wt', 'argocd-trees'));
    });

    it('reads a relative setting from the folder that holds the repo', () => {
      assert.equal(worktreeRootFor(REPO, '.wt', HOME), path.join(path.sep, 'src', 'harm', '.wt', 'argocd'));
    });
  });

  it('declares the setting with an empty default (the hidden folder)', () => {
    const props = (manifest as any).contributes.configuration.properties;
    assert.equal(props['agentWorkbench.worktreesFolder'].default, '');
  });

  it('creates a session worktree in the hidden folder, which repo discovery does not mistake for a repo', async () => {
    const { parent, repo } = await makeRepo();
    const store = new SessionStore(path.join(parent, 'sessions.json'));
    const s = await startSession({ repo, baseRef: 'main', store, adhoc: { title: 'spike', description: '' }, worktreeRoot: worktreeRootFor(repo, '', HOME) });
    assert.equal(s.worktree, path.join(parent, '.worktrees', 'repo', s.id));
    assert.ok(fs.existsSync(path.join(s.worktree, '.git')));
    await createWorktree({ repo, slug: 'other-1', baseRef: 'main', root: worktreeRootFor(repo, '', HOME) });
    assert.deepEqual((await discoverRepos([parent])).map((r) => r.root), [repo]);
  });

  it('removes the emptied worktree folders when the last session of a repo is deleted, in both layouts', async () => {
    const { parent, repo } = await makeRepo();
    const store = new SessionStore(path.join(parent, 'sessions.json'));
    const hidden = await startSession({ repo, baseRef: 'main', store, adhoc: { title: 'one', description: '' }, worktreeRoot: worktreeRootFor(repo, '', HOME) });
    const sibling = await startSession({ repo, baseRef: 'main', store, adhoc: { title: 'two', description: '' } });
    const other = await startSession({ repo, baseRef: 'main', store, adhoc: { title: 'three', description: '' } });
    await deleteSession(store, sibling);
    assert.ok(fs.existsSync(`${repo}.worktrees`), 'another session still lives there');
    await deleteSession(store, other);
    assert.ok(!fs.existsSync(`${repo}.worktrees`));
    await deleteSession(store, hidden);
    assert.ok(!fs.existsSync(path.join(parent, '.worktrees')));
    assert.ok(fs.existsSync(repo));
  });
});
