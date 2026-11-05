const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

suite('changes', () => {
  let parent;
  let worktree;

  suiteSetup(() => {
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-int-')));
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base line\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    worktree = path.join(parent, 'repo.worktrees', 's-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'wb/s-1', worktree, 'main');
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'agent line\n');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Best effort: on Windows VS Code can still hold the folder briefly; a leftover temp folder is harmless.
    try {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore
    }
  });

  test('opens a side-by-side diff: base content left, worktree file right', async () => {
    await vscode.extensions.getExtension('local.agent-workbench').activate();
    const session = { id: 's-1', repo: path.join(parent, 'repo'), worktree, branch: 'wb/s-1', baseRef: 'main', createdAt: 't' };
    await vscode.commands.executeCommand('agentWorkbench.openChange', { kind: 'change', session, file: { path: 'a.txt', status: 'modified' } });

    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'active tab is not a diff');
    assert.equal(input.original.scheme, 'wb-base');
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'base line\n');
    assert.equal(input.modified.fsPath.toLowerCase(), path.join(worktree, 'a.txt').toLowerCase());
  });

  test('shows an empty base side for a file the session added', async () => {
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'brand new\n');
    const session = { id: 's-1', repo: path.join(parent, 'repo'), worktree, branch: 'wb/s-1', baseRef: 'main', createdAt: 't' };
    await vscode.commands.executeCommand('agentWorkbench.openChange', { kind: 'change', session, file: { path: 'new.txt', status: 'untracked' } });

    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), '');
  });

  test('a branch with a checkout opens the editable worktree file on the right', async () => {
    const repo = path.join(parent, 'repo');
    const target = { repo, branch: 'wb/s-1', baseRef: 'main', worktree };
    await vscode.commands.executeCommand('agentWorkbench.openBranchChange', { kind: 'branchChange', target, file: { path: 'a.txt', status: 'modified' } });

    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'active tab is not a diff');
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'base line\n');
    assert.equal(input.modified.scheme, 'file');
    assert.equal(input.modified.fsPath.toLowerCase(), path.join(worktree, 'a.txt').toLowerCase());
  });

  test('a branch without a checkout opens read-only git content on both sides', async () => {
    const repo = path.join(parent, 'repo');
    const temp = path.join(parent, 'repo.worktrees', 'tmp');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/PROJ-1-x', temp, 'main');
    fs.writeFileSync(path.join(temp, 'a.txt'), 'branch line\n');
    git(temp, 'commit', '-q', '-am', 'on branch');
    git(repo, 'worktree', 'remove', temp);

    const target = { repo, branch: 'feature/PROJ-1-x', baseRef: 'main' };
    await vscode.commands.executeCommand('agentWorkbench.openBranchChange', { kind: 'branchChange', target, file: { path: 'a.txt', status: 'modified' } });

    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'active tab is not a diff');
    assert.equal(input.original.scheme, 'wb-base');
    assert.equal(input.modified.scheme, 'wb-base');
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'base line\n');
    assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'branch line\n');
  });
});
