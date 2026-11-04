import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../../src/git/git';

// A throwaway repo with three committed files, inside a temp parent folder (worktrees go next to it).
export async function makeRepo(): Promise<{ parent: string; repo: string }> {
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

export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-q', '-m', message]);
}
