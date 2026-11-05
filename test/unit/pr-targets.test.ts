import { strict as assert } from 'assert';
import { prTargets } from '../../src/pr/targets';
import { Session } from '../../src/sessions/model';
import { RepoWork } from '../../src/tickets/workIndex';

const repo = (name: string) => ({ root: `/w/${name}`, name, workspaceRoot: '/w' });
const work = (name: string, branches: string[]): RepoWork => ({ repo: repo(name), baseRef: 'main', branches, worktrees: [] });
const ticket = { source: 'Jira HDO', id: 'HDO-2064' };
const session = (id: string, repoName: string): Session => ({
  id,
  repo: `/w/${repoName}`,
  worktree: `/w/${repoName}.worktrees/${id}`,
  branch: `wb/${id}`,
  baseRef: 'main',
  createdAt: '2026-11-05T10:00:00Z',
  ticket: { source: 'Jira HDO', id: 'HDO-2064', title: 't' },
});

describe('prTargets', () => {
  it('asks only the repos that carry work for the ticket, with that work\'s branches', () => {
    const targets = prTargets(
      [work('billing', ['main', 'wb/jira-hdo-hdo-2064-1', 'feature/HDO-2064-x', 'unrelated']), work('portal', ['main', 'other']), work('infra', ['hdo-2064-infra'])],
      ticket,
      [session('jira-hdo-hdo-2064-1', 'billing')],
    );
    assert.deepEqual(
      targets.map((t) => [t.repo.name, t.repo.root, t.branches]),
      [
        ['billing', '/w/billing', ['wb/jira-hdo-hdo-2064-1', 'feature/HDO-2064-x']],
        ['infra', '/w/infra', ['hdo-2064-infra']],
      ],
    );
  });

  it('includes a repo that only has a session of the ticket, even if its branch name carries no key', () => {
    const targets = prTargets([work('billing', ['main', 'wb/odd-name-1'])], ticket, [{ ...session('odd-name-1', 'billing'), branch: 'wb/odd-name-1' }]);
    assert.deepEqual(targets.map((t) => t.branches), [['wb/odd-name-1']]);
  });

  it('does not ask any repo for a ticket without work', () => {
    assert.deepEqual(prTargets([work('billing', ['main'])], ticket, []), []);
  });

  it('ignores sessions of other tickets', () => {
    const other = { ...session('x-1', 'billing'), ticket: { source: 'Jira HDO', id: 'HDO-1', title: 't' } };
    assert.deepEqual(prTargets([work('billing', ['main', 'wb/x-1'])], ticket, [other]), []);
  });
});
