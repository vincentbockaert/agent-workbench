import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parsePullRequests, prsForTicket, PullRequest } from '../../src/pr/model';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'gh-prs.json'), 'utf8'));
const repo = { name: 'billing', root: '/w/billing' };
const all = parsePullRequests(fixture, repo);
const byNumber = (n: number) => all.find((p) => p.number === n)!;

describe('parsePullRequests', () => {
  it('skips entries that are not pull requests', () => {
    assert.deepEqual(all.map((p) => p.number), [412, 413, 398, 377, 420]);
  });

  it('maps state and draft: open, draft, merged, closed', () => {
    assert.deepEqual([412, 413, 398, 377].map((n) => byNumber(n).state), ['open', 'draft', 'merged', 'closed']);
  });

  it('keeps what the page needs to show and link', () => {
    const p = byNumber(412);
    assert.deepEqual(
      [p.repo, p.repoRoot, p.title, p.url, p.branch, p.base, p.author, p.updatedAt],
      ['billing', '/w/billing', 'HDO-2064: redirect identity for Azure multitenant', 'https://github.com/acme/billing/pull/412', 'wb/jira-hdo-hdo-2064-1', 'main', 'vbo', '2026-11-05T09:30:00Z'],
    );
    assert.equal(byNumber(398).mergedAt, '2026-11-01T08:00:00Z');
    assert.equal(byNumber(420).author, undefined);
  });

  it('maps the review decision', () => {
    assert.deepEqual([412, 413, 377, 420].map((n) => byNumber(n).review), ['approved', 'none', 'required', 'changes']);
  });

  it('summarises checks: fail beats pending beats pass; skipped checks are ignored; no checks is "none"', () => {
    assert.deepEqual([412, 413, 398, 377, 420].map((n) => byNumber(n).checks), ['pass', 'pending', 'none', 'none', 'fail']);
  });

  it('flags merge conflicts only when GitHub says CONFLICTING', () => {
    assert.deepEqual([412, 413, 420].map((n) => byNumber(n).conflicts), [false, false, true]);
  });

  it('copes with anything that is not a list', () => {
    for (const bad of [null, undefined, {}, 'x', 5]) {
      assert.deepEqual(parsePullRequests(bad, repo), []);
    }
  });

  it('treats unknown values as neutral instead of failing', () => {
    const [p] = parsePullRequests([{ number: 1, title: 't', url: 'https://x/1', state: 'WEIRD', headRefName: 'b', baseRefName: 'main', updatedAt: 'u', reviewDecision: 'SURPRISE', statusCheckRollup: [{ foo: 1 }] }], repo);
    assert.deepEqual([p.state, p.review, p.checks], ['open', 'none', 'none']);
  });

  it('counts timed-out and startup-failed checks as failures, and queued or waiting ones as pending', () => {
    const rollup = (items: object[]) => parsePullRequests([{ number: 1, title: 't', url: 'https://x/1', state: 'OPEN', headRefName: 'b', baseRefName: 'main', updatedAt: 'u', statusCheckRollup: items }], repo)[0].checks;
    assert.equal(rollup([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'fail');
    assert.equal(rollup([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }]), 'fail');
    assert.equal(rollup([{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }]), 'pending');
    assert.equal(rollup([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
    assert.equal(rollup([{ __typename: 'StatusContext', state: 'ERROR' }]), 'fail');
  });
});

describe('prsForTicket', () => {
  const ticket = { id: 'HDO-2064' };

  it('takes PRs whose head branch is one of the ticket\'s branches, by key in the branch, or by key in the title', () => {
    const mine = prsForTicket(all, ticket, new Set(['wb/jira-hdo-hdo-2064-1']));
    // 412 by branch set; 413 by key in branch; 398 by key in title; 377 and 420 have wb/ branches that carry the key too.
    assert.deepEqual(mine.map((p) => p.number).sort(), [377, 398, 412, 413, 420]);
  });

  it('does not take PRs that merely look similar (HDO-20641 is another ticket)', () => {
    const other: PullRequest = { ...byNumber(412), number: 9, title: 'HDO-20641: other', branch: 'hdo-20641-x' };
    assert.deepEqual(prsForTicket([other], ticket, new Set()), []);
  });

  it('uses the branch set for tickets whose id carries no key (a numeric id)', () => {
    const pr = { ...byNumber(412), title: 'Fix #12 crash', branch: 'wb/github-12-1' };
    assert.deepEqual(prsForTicket([pr], { id: '12' }, new Set(['wb/github-12-1'])).length, 1);
    assert.deepEqual(prsForTicket([pr], { id: '12' }, new Set()).length, 0);
  });

  it('sorts open before draft before merged before closed, then newest first', () => {
    const mine = prsForTicket(all, ticket, new Set());
    assert.deepEqual(mine.map((p) => p.number), [412, 420, 413, 398, 377].sort((a, b) => order(a) - order(b) || Date.parse(byNumber(b).updatedAt) - Date.parse(byNumber(a).updatedAt)));
    assert.deepEqual(mine.map((p) => p.state), ['open', 'open', 'draft', 'merged', 'closed']);
    assert.deepEqual(mine.slice(0, 2).map((p) => p.number), [412, 420]); // 412 updated more recently than 420
  });
});

function order(n: number): number {
  return { open: 0, draft: 1, merged: 2, closed: 3 }[byNumber(n).state];
}
