import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverRepos } from '../../src/git/repos';
import { git } from '../../src/git/git';
import { expandSources } from '../../src/tickets/expand';
import { readSnapshot, refreshAll } from '../../src/tickets/snapshot';
import { TicketSourceConfig } from '../../src/tickets/source';
import { ticketKeyOf } from '../../src/time/rules';
import { sessionsInRepos } from '../../src/sessions/model';

const printCwd = `node "${path.join(__dirname, '..', 'fixtures', 'print-cwd.js')}"`;
const map = { id: 'id', title: 'title' };

async function twoRepos(): Promise<{ parent: string; snapshots: string }> {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-multi-')));
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(parent, name));
    await git(path.join(parent, name), ['init', '-q', '-b', 'main']);
  }
  return { parent, snapshots: path.join(parent, '.snapshots') };
}

describe('refreshAll with several repos', () => {
  it('runs a repo-scoped source in each repo and keeps their tickets apart', async () => {
    const { parent, snapshots } = await twoRepos();
    const gh: TicketSourceConfig = { name: 'GitHub', listCmd: printCwd, map };
    const sources = expandSources([gh], await discoverRepos([parent]), parent);
    await refreshAll(sources, snapshots, new Date());

    const alpha = readSnapshot(snapshots, 'GitHub · alpha');
    const beta = readSnapshot(snapshots, 'GitHub · beta');
    assert.deepEqual(alpha?.tickets.map((t) => [t.source, t.id]), [['GitHub · alpha', 'alpha-1']]);
    assert.deepEqual(beta?.tickets.map((t) => [t.source, t.id]), [['GitHub · beta', 'beta-1']]);
    assert.notEqual(ticketKeyOf('GitHub · alpha', '1'), ticketKeyOf('GitHub · beta', '1'));
  });

  it('runs a workspace-scoped source once, in the window root', async () => {
    const { parent, snapshots } = await twoRepos();
    const jira: TicketSourceConfig = { name: 'Jira', listCmd: printCwd, map, scope: 'workspace' };
    const sources = expandSources([jira], await discoverRepos([parent]), parent);
    await refreshAll(sources, snapshots, new Date());

    assert.deepEqual(readSnapshot(snapshots, 'Jira')?.tickets.map((t) => t.id), [`${path.basename(parent)}-1`]);
    assert.equal(readSnapshot(snapshots, 'Jira · alpha'), undefined);
  });

  it('refreshes many repos, returning snapshots in the order of the sources', async () => {
    const { parent, snapshots } = await twoRepos();
    const sources = Array.from({ length: 11 }, (_, i) => ({
      cfg: { name: `Src ${i}`, listCmd: printCwd, map },
      cwd: parent,
    }));
    const results = await refreshAll(sources, snapshots, new Date());
    assert.deepEqual(results.map((r) => r.source), sources.map((s) => s.cfg.name));
    assert.ok(results.every((r) => r.tickets.length === 1 && !r.error));
  });

  it('records the error of one repo without losing the others', async () => {
    const { parent, snapshots } = await twoRepos();
    const failing = `node "${path.join(__dirname, '..', 'fixtures', 'fail.js')}"`;
    const flaky: TicketSourceConfig = { name: 'Flaky', listCmd: `${printCwd} && ${failing}`, map };
    const sources = expandSources([flaky, { name: 'Ok', listCmd: printCwd, map }], await discoverRepos([parent]), parent);
    await refreshAll(sources, snapshots, new Date());

    assert.ok(readSnapshot(snapshots, 'Flaky · alpha')?.error);
    assert.equal(readSnapshot(snapshots, 'Ok · beta')?.tickets.length, 1);
  });
});

describe('sessionsInRepos', () => {
  const session = (id: string, repo: string) => ({ id, repo, worktree: `${repo}.worktrees/${id}`, branch: `wb/${id}`, baseRef: 'main', createdAt: '2026-01-01T00:00:00Z' });

  it('keeps sessions of any repo found in the window and hides the rest', async () => {
    const { parent } = await twoRepos();
    const repos = await discoverRepos([parent]);
    const sessions = [session('a', path.join(parent, 'alpha')), session('b', path.join(parent, 'beta')), session('x', '/elsewhere/other')];
    assert.deepEqual(sessionsInRepos(sessions, repos).map((s) => s.id), ['a', 'b']);
  });

  it('matches a session whose repo path goes through a symlink', async () => {
    const { parent } = await twoRepos();
    const link = path.join(os.tmpdir(), `wb-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(parent, link);
    const repos = await discoverRepos([parent]);
    assert.deepEqual(sessionsInRepos([session('a', path.join(link, 'alpha'))], repos).map((s) => s.id), ['a']);
  });

  it('shows nothing when no repo was found', () => {
    assert.deepEqual(sessionsInRepos([session('a', '/r')], []), []);
  });
});
