import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { decodeBaseQuery, diffStats, encodeBaseQuery, fileAtRef, mergeBase } from '../../src/git/diff';
import { git } from '../../src/git/git';
import { createWorktree } from '../../src/git/worktree';
import { commitAll, makeRepo } from './helpers/repo';

describe('diff', function () {
  this.timeout(20000);
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    ({ parent, repo } = await makeRepo());
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  describe('diffStats', () => {
    it('counts added and removed lines for committed, uncommitted, deleted and untracked files', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      fs.writeFileSync(path.join(wt.path, 'edit.txt'), 'after\nmore\n'); // 1 removed, 2 added
      fs.rmSync(path.join(wt.path, 'gone.txt')); // 1 removed
      await commitAll(wt.path, 'agent work');
      fs.writeFileSync(path.join(wt.path, 'keep.txt'), 'keep\nextra\n'); // uncommitted: 1 added
      fs.writeFileSync(path.join(wt.path, 'new.md'), 'a\nb\nc\n'); // untracked: 3 added

      const stats = await diffStats(wt.path, 'main');
      assert.deepEqual(Object.fromEntries(stats), {
        'edit.txt': { added: 2, removed: 1 },
        'gone.txt': { added: 0, removed: 1 },
        'keep.txt': { added: 1, removed: 0 },
        'new.md': { added: 3, removed: 0 },
      });
    });

    it('counts a last line without a trailing newline', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      fs.writeFileSync(path.join(wt.path, 'new.md'), 'a\nb');
      assert.deepEqual((await diffStats(wt.path, 'main')).get('new.md'), { added: 2, removed: 0 });
    });

    it('leaves binary files out', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      fs.writeFileSync(path.join(wt.path, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
      await commitAll(wt.path, 'binary');
      fs.writeFileSync(path.join(wt.path, 'raw.bin'), Buffer.from([0, 0, 7]));
      const stats = await diffStats(wt.path, 'main');
      assert.equal(stats.has('img.bin'), false);
      assert.equal(stats.has('raw.bin'), false);
    });

    it('is empty for a fresh worktree', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      assert.equal((await diffStats(wt.path, 'main')).size, 0);
    });
  });

  describe('mergeBase + fileAtRef', () => {
    it('reads the base content, unaffected by later commits on the base branch', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      const base = await mergeBase(wt.path, 'main');
      fs.writeFileSync(path.join(repo, 'edit.txt'), 'changed on main\n');
      await commitAll(repo, 'main moves on');

      assert.equal(await mergeBase(wt.path, 'main'), base);
      assert.equal(await fileAtRef(wt.path, base, 'edit.txt'), 'before\n');
    });

    it('reads files in subfolders', async () => {
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'x.ts'), 'export {};\n');
      await commitAll(repo, 'sub');
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      assert.equal(await fileAtRef(wt.path, await mergeBase(wt.path, 'main'), 'src/x.ts'), 'export {};\n');
    });

    it('returns empty content for a file that did not exist at the base', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      assert.equal(await fileAtRef(wt.path, await mergeBase(wt.path, 'main'), 'brand-new.ts'), '');
    });

    it('fails for an unknown ref instead of pretending the file is empty', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      await assert.rejects(fileAtRef(wt.path, 'no-such-ref', 'edit.txt'));
    });

    it('fails for an unknown base branch', async () => {
      const wt = await createWorktree({ repo, slug: 's', baseRef: 'main' });
      await git(wt.path, ['status']);
      await assert.rejects(mergeBase(wt.path, 'no-such-branch'));
    });
  });

  describe('base query', () => {
    it('round-trips paths with spaces, unicode and query characters', () => {
      const q = { worktree: 'C:\\Users\\me\\repo.worktrees\\a b', ref: 'abc123', path: 'src/ünï code?&=#.ts' };
      assert.deepEqual(decodeBaseQuery(encodeBaseQuery(q)), q);
    });

    it('rejects malformed queries', () => {
      assert.equal(decodeBaseQuery('nonsense'), undefined);
      assert.equal(decodeBaseQuery(encodeURIComponent(JSON.stringify({ worktree: 'w' }))), undefined);
    });
  });
});
