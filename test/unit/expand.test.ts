import { strict as assert } from 'assert';
import { expandSources } from '../../src/tickets/expand';
import { RepoInfo } from '../../src/git/repos';
import { TicketSourceConfig } from '../../src/tickets/source';
import manifest from '../../package.json';

const map = { id: 'id', title: 'title' };
const gh: TicketSourceConfig = { name: 'GitHub', listCmd: 'gh issue list', map };
const jira: TicketSourceConfig = { name: 'Jira', listCmd: 'curl jira', map, scope: 'workspace' };
const repo = (name: string): RepoInfo => ({ root: `/w/${name}`, name, workspaceRoot: '/w' });

describe('expandSources', () => {
  it('keeps names and runs in the repo when there is exactly one repo', () => {
    const out = expandSources([gh, jira], [repo('only')], '/w/only');
    assert.deepEqual(
      out.map((s) => [s.cfg.name, s.cwd, s.repo?.name]),
      [
        ['GitHub', '/w/only', 'only'],
        ['Jira', '/w/only', undefined],
      ],
    );
  });

  it('runs a repo-scoped source in every repo, with the repo name in the source name', () => {
    const out = expandSources([gh], [repo('a'), repo('b')], '/w');
    assert.deepEqual(
      out.map((s) => [s.cfg.name, s.cwd, s.repo?.root]),
      [
        ['GitHub · a', '/w/a', '/w/a'],
        ['GitHub · b', '/w/b', '/w/b'],
      ],
    );
  });

  it('runs a workspace-scoped source once in the window root, unchanged', () => {
    const out = expandSources([jira], [repo('a'), repo('b')], '/w');
    assert.deepEqual(
      out.map((s) => [s.cfg.name, s.cwd, s.repo]),
      [['Jira', '/w', undefined]],
    );
  });

  it('treats a missing scope as "repo"', () => {
    assert.equal(expandSources([gh], [repo('a'), repo('b')], '/w').length, 2);
  });

  it('runs repo-scoped sources once in the root under their plain name when no repo was found', () => {
    const out = expandSources([gh, jira], [], '/w');
    assert.deepEqual(
      out.map((s) => [s.cfg.name, s.cwd, s.repo]),
      [
        ['GitHub', '/w', undefined],
        ['Jira', '/w', undefined],
      ],
    );
  });

  it('keeps every other field of the config', () => {
    const [first] = expandSources([{ ...gh, itemsPath: 'items' }], [repo('a'), repo('b')], '/w');
    assert.equal(first.cfg.itemsPath, 'items');
    assert.equal(first.cfg.listCmd, 'gh issue list');
  });
});

describe('ticketSources schema', () => {
  it('offers the scope field with its two values', () => {
    const props = manifest.contributes.configuration.properties['agentWorkbench.ticketSources'].items.properties as Record<string, any>;
    assert.deepEqual(props.scope.enum, ['repo', 'workspace']);
  });
});
