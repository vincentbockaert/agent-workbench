import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isStale, readPrSnapshot, refreshTicketPrs, writePrSnapshot } from '../../src/pr/cache';
import { fetchRepoPullRequests, FetchResult } from '../../src/pr/fetch';
import { PullRequest } from '../../src/pr/model';

const fixtureFile = path.join(__dirname, '..', 'fixtures', 'gh-prs.json');
const repoA = { name: 'billing', root: '/w/billing' };
const repoB = { name: 'portal', root: '/w/portal' };

describe('fetchRepoPullRequests (fake gh)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pr-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeGh(body: string): string {
    const file = path.join(dir, 'gh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it('lists all PRs of the repo with the fields the page needs, run inside the repo', async () => {
    const gh = fakeGh(`echo "$PWD|$@" > "${dir}/call.txt"; cat "${fixtureFile}"`);
    const res = await fetchRepoPullRequests({ name: 'repo', root: dir }, { gh });
    assert.equal(res.error, undefined);
    assert.deepEqual(res.prs.map((p) => p.number), [412, 413, 398, 377, 420]);
    const call = fs.readFileSync(path.join(dir, 'call.txt'), 'utf8');
    assert.ok(call.startsWith(`${fs.realpathSync.native(dir)}|pr list --state all --limit 100 --json number,title,url,`), call);
    assert.match(call, /statusCheckRollup/);
  });

  it('says gh is not installed', async () => {
    const res = await fetchRepoPullRequests(repoA, { gh: path.join(dir, 'missing-gh') });
    assert.match(res.error ?? '', /not installed/);
    assert.deepEqual(res.prs, []);
  });

  it('says gh is not logged in', async () => {
    const gh = fakeGh(`echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`);
    assert.match((await fetchRepoPullRequests({ name: 'r', root: dir }, { gh })).error ?? '', /gh auth login/);
  });

  it('treats a repo without a GitHub remote as "nothing to show", not as an error', async () => {
    const gh = fakeGh(`echo 'none of the git remotes configured for this repository point to a known GitHub host' >&2; exit 1`);
    const res = await fetchRepoPullRequests({ name: 'r', root: dir }, { gh });
    assert.deepEqual([res.error, res.noRemote, res.prs], [undefined, true, []]);
  });

  it('gives up on a gh that hangs', async () => {
    const gh = fakeGh('exec sleep 5');
    const res = await fetchRepoPullRequests({ name: 'r', root: dir }, { gh, timeoutMs: 200 });
    assert.match(res.error ?? '', /timed out/);
  });

  it('reports output that is not JSON', async () => {
    const gh = fakeGh('echo "this is not json"');
    assert.match((await fetchRepoPullRequests({ name: 'r', root: dir }, { gh })).error ?? '', /unreadable/);
  });

  it('shows the first line of any other failure', async () => {
    const gh = fakeGh(`echo 'HTTP 502: bad gateway' >&2; echo 'more' >&2; exit 1`);
    assert.equal((await fetchRepoPullRequests({ name: 'r', root: dir }, { gh })).error, 'HTTP 502: bad gateway');
  });
});

describe('PR snapshot cache', () => {
  let dir: string;
  const now = new Date('2026-11-05T12:00:00Z');
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-prc-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pr = (repo: string, number: number, branch: string, title = 't'): PullRequest => ({
    repo,
    repoRoot: `/w/${repo}`,
    number,
    title,
    url: `https://github.com/acme/${repo}/pull/${number}`,
    state: 'open',
    branch,
    base: 'main',
    updatedAt: '2026-11-05T11:00:00Z',
    review: 'none',
    checks: 'none',
    conflicts: false,
  });
  const ok = (...prs: PullRequest[]): FetchResult => ({ prs });
  const ticket = { id: 'HDO-1' };

  it('writes and reads a snapshot; a missing or corrupt file means "none yet"', () => {
    assert.equal(readPrSnapshot(dir, 'Jira:HDO-1'), undefined);
    const snap = { ticket: 'Jira:HDO-1', fetchedAt: now.toISOString(), prs: [pr('billing', 1, 'b')], errors: [] };
    writePrSnapshot(dir, snap);
    assert.deepEqual(readPrSnapshot(dir, 'Jira:HDO-1'), snap);
    fs.writeFileSync(path.join(dir, `${encodeURIComponent('Jira:HDO-2')}.json`), '{not json');
    assert.equal(readPrSnapshot(dir, 'Jira:HDO-2'), undefined);
  });

  it('keeps only the PRs of the ticket, per repo, from its branches or its key', async () => {
    const fetched: Record<string, FetchResult> = {
      '/w/billing': ok(pr('billing', 1, 'wb/s-1'), pr('billing', 2, 'unrelated'), pr('billing', 3, 'x', 'HDO-1 fix')),
      '/w/portal': ok(pr('portal', 9, 'wb/s-1')), // same branch name, but portal has no such branch for this ticket
    };
    const snap = await refreshTicketPrs('Jira:HDO-1', ticket, [{ repo: repoA, branches: ['wb/s-1'] }, { repo: repoB, branches: [] }], dir, now, { fetch: async (r) => fetched[r.root] });
    assert.deepEqual(snap.prs.map((p) => `${p.repo}#${p.number}`), ['billing#1', 'billing#3']);
    assert.equal(snap.fetchedAt, now.toISOString());
    assert.deepEqual(snap.errors, []);
    assert.deepEqual(readPrSnapshot(dir, 'Jira:HDO-1'), snap);
  });

  it('keeps the previous PRs of a repo that failed now, and records the error', async () => {
    writePrSnapshot(dir, { ticket: 'Jira:HDO-1', fetchedAt: '2026-11-05T08:00:00Z', prs: [pr('portal', 9, 'wb/s-2')], errors: [] });
    const snap = await refreshTicketPrs('Jira:HDO-1', ticket, [{ repo: repoA, branches: ['wb/s-1'] }, { repo: repoB, branches: ['wb/s-2'] }], dir, now, {
      fetch: async (r) => (r.root === '/w/billing' ? ok(pr('billing', 1, 'wb/s-1')) : { prs: [], error: 'HTTP 502' }),
    });
    assert.deepEqual(snap.prs.map((p) => `${p.repo}#${p.number}`).sort(), ['billing#1', 'portal#9']);
    assert.deepEqual(snap.errors, [{ repo: 'portal', message: 'HTTP 502' }]);
    assert.equal(snap.fetchedAt, now.toISOString());
  });

  it('keeps the old fetch time when every repo failed', async () => {
    writePrSnapshot(dir, { ticket: 'Jira:HDO-1', fetchedAt: '2026-11-05T08:00:00Z', prs: [pr('billing', 1, 'wb/s-1')], errors: [] });
    const snap = await refreshTicketPrs('Jira:HDO-1', ticket, [{ repo: repoA, branches: ['wb/s-1'] }], dir, now, { fetch: async () => ({ prs: [], error: 'gh is not installed' }) });
    assert.equal(snap.fetchedAt, '2026-11-05T08:00:00Z');
    assert.equal(snap.prs.length, 1);
    assert.equal(snap.errors[0].message, 'gh is not installed');
  });

  it('does not show an error for a repo without a GitHub remote, and drops its old PRs', async () => {
    writePrSnapshot(dir, { ticket: 'Jira:HDO-1', fetchedAt: '2026-11-05T08:00:00Z', prs: [pr('billing', 1, 'wb/s-1')], errors: [] });
    const snap = await refreshTicketPrs('Jira:HDO-1', ticket, [{ repo: repoA, branches: ['wb/s-1'] }], dir, now, { fetch: async () => ({ prs: [], noRemote: true }) });
    assert.deepEqual([snap.prs, snap.errors], [[], []]);
  });

  it('is an empty, fresh snapshot when the ticket has no branches to look at', async () => {
    const snap = await refreshTicketPrs('Jira:HDO-1', ticket, [], dir, now, { fetch: async () => assert.fail('must not run gh') });
    assert.deepEqual([snap.prs, snap.errors, snap.fetchedAt], [[], [], now.toISOString()]);
  });

  it('runs at most four repos at once', async () => {
    let running = 0;
    let most = 0;
    const targets = Array.from({ length: 11 }, (_, i) => ({ repo: { name: `r${i}`, root: `/w/r${i}` }, branches: [] }));
    await refreshTicketPrs('Jira:HDO-1', ticket, targets, dir, now, {
      fetch: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return ok();
      },
    });
    assert.equal(most, 4);
  });

  it('is stale when never fetched or older than the limit', () => {
    const snap = { ticket: 'k', fetchedAt: '2026-11-05T11:58:00Z', prs: [], errors: [] };
    assert.equal(isStale(undefined, now, 5 * 60_000), true);
    assert.equal(isStale({ ...snap, fetchedAt: undefined }, now, 5 * 60_000), true);
    assert.equal(isStale(snap, now, 5 * 60_000), false);
    assert.equal(isStale({ ...snap, fetchedAt: '2026-11-05T11:50:00Z' }, now, 5 * 60_000), true);
  });
});
