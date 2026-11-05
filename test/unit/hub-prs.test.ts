import { strict as assert } from 'assert';
import { buildTicketHub, HubInput } from '../../src/hub/model';
import { parseHubMessage, renderTicketHub } from '../../src/hub/render';
import { PrSnapshot } from '../../src/pr/cache';
import { PullRequest } from '../../src/pr/model';
import { localDays } from '../../src/time/report';

const NOW = new Date(2026, 10, 5, 15, 0);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const pr = (extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: 'billing',
  repoRoot: '/w/billing',
  number: 412,
  title: 'HDO-2064: redirect identity',
  url: 'https://github.com/acme/billing/pull/412',
  state: 'open',
  branch: 'wb/jira-hdo-hdo-2064-1',
  base: 'main',
  author: 'vbo',
  updatedAt: ago(90),
  review: 'approved',
  checks: 'pass',
  conflicts: false,
  ...extra,
});

function input(prs: HubInput['pullRequests']): HubInput {
  return {
    ticket: { key: 'Jira:HDO-2064', source: 'Jira', id: 'HDO-2064', title: 'Redirect', listed: true },
    sessions: [],
    statuses: {},
    changes: {},
    events: [],
    week: localDays(new Date(2026, 10, 2), new Date(2026, 10, 8)),
    now: NOW,
    opts: { idleMs: 300_000, booked: 'timer', roundToMinutes: 15 },
    pullRequests: prs,
  };
}
const snap = (prs: PullRequest[], extra: Partial<PrSnapshot> = {}): PrSnapshot => ({ ticket: 'Jira:HDO-2064', fetchedAt: ago(7), prs, errors: [], ...extra });
const html = (prs: HubInput['pullRequests']) => renderTicketHub(buildTicketHub(input(prs)), 'n', 'c');

describe('hub pull requests: model', () => {
  it('is disabled and empty when no PR data is given', () => {
    assert.deepEqual(buildTicketHub(input(undefined)).pullRequests, { enabled: false, items: [], errors: [], refreshing: false });
  });

  it('turns a snapshot into display rows with a stable id and a readable age', () => {
    const m = buildTicketHub(input({ enabled: true, snapshot: snap([pr()]), refreshing: false })).pullRequests;
    assert.equal(m.enabled, true);
    assert.deepEqual(m.items.map((i) => [i.id, i.number, i.repo, i.age, i.author]), [['/w/billing#412', 412, 'billing', '1h ago', 'vbo']]);
    assert.equal(m.fetchedAgo, '7m ago');
  });

  it('words ages: just now, minutes, hours, days', () => {
    const ages = [0, 5, 130, 60 * 24 * 3].map((min) => buildTicketHub(input({ enabled: true, snapshot: snap([pr({ updatedAt: ago(min) })]), refreshing: false })).pullRequests.items[0].age);
    assert.deepEqual(ages, ['just now', '5m ago', '2h ago', '3d ago']);
  });

  it('carries the errors and the refreshing flag', () => {
    const m = buildTicketHub(input({ enabled: true, snapshot: snap([], { errors: [{ repo: 'portal', message: 'gh is not logged in' }] }), refreshing: true })).pullRequests;
    assert.deepEqual([m.errors, m.refreshing], [['portal: gh is not logged in'], true]);
  });

  it('has no "updated" time before the first fetch', () => {
    assert.equal(buildTicketHub(input({ enabled: true, refreshing: true })).pullRequests.fetchedAgo, undefined);
  });
});

describe('hub pull requests: page', () => {
  it('has no section when pull requests are switched off', () => {
    assert.doesNotMatch(html({ enabled: false, refreshing: false }), /PULL REQUESTS/);
  });

  it('lists each PR with state, title, repo, number, branches, checks, review and an Open button', () => {
    const page = html({ enabled: true, snapshot: snap([pr()]), refreshing: false });
    assert.match(page, /PULL REQUESTS · 1/);
    assert.match(page, /HDO-2064: redirect identity/);
    assert.match(page, /billing #412/);
    assert.match(page, /wb\/jira-hdo-hdo-2064-1 → main/);
    assert.match(page, /Open/);
    assert.match(page, /Passing/);
    assert.match(page, /Approved/);
    assert.match(page, /data-command="openPr" data-pr="\/w\/billing#412"/);
    assert.match(page, /data-command="refreshPrs"/);
    assert.match(page, /Updated 7m ago/);
  });

  it('shows state words and the signals that need attention', () => {
    const page = html({
      enabled: true,
      refreshing: false,
      snapshot: snap([
        pr({ number: 1, state: 'draft', checks: 'pending', review: 'none' }),
        pr({ number: 2, state: 'merged', checks: 'none', review: 'approved' }),
        pr({ number: 3, state: 'closed' }),
        pr({ number: 4, checks: 'fail', review: 'changes', conflicts: true }),
        pr({ number: 5, review: 'required' }),
      ]),
    });
    for (const word of ['Draft', 'Merged', 'Closed', 'Open', 'Running', 'Failing', 'Changes requested', 'Review required', 'conflicts']) {
      assert.ok(page.includes(word), `missing "${word}"`);
    }
  });

  it('escapes PR text, which is untrusted', () => {
    const page = html({ enabled: true, snapshot: snap([pr({ title: '<img src=x onerror=alert(1)>', branch: '"><b>', author: '<i>' })]), refreshing: false });
    assert.doesNotMatch(page, /<img src=x/);
    assert.doesNotMatch(page, /"><b>/);
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('says so when there are none, and explains how PRs are found', () => {
    const page = html({ enabled: true, snapshot: snap([]), refreshing: false });
    assert.match(page, /No pull requests/);
    assert.match(page, /branch|key/);
  });

  it('shows per-repo errors without hiding the PRs that are known', () => {
    const page = html({ enabled: true, snapshot: snap([pr()], { errors: [{ repo: 'portal', message: 'gh is not logged in: run `gh auth login`' }] }), refreshing: false });
    assert.match(page, /portal: gh is not logged in/);
    assert.match(page, /HDO-2064: redirect identity/);
  });

  it('disables Refresh while refreshing, and says it is loading when nothing is cached yet', () => {
    const page = html({ enabled: true, refreshing: true });
    assert.match(page, /Refreshing/);
    assert.match(page, /<button[^>]*data-command="refreshPrs"[^>]*disabled/);
    assert.match(page, /Loading pull requests/);
  });
});

describe('hub pull requests: messages from the page', () => {
  it('accepts refreshPrs and openPr with an id, and nothing else', () => {
    assert.deepEqual(parseHubMessage({ command: 'refreshPrs' }), { command: 'refreshPrs' });
    assert.deepEqual(parseHubMessage({ command: 'openPr', pr: '/w/billing#412' }), { command: 'openPr', pr: '/w/billing#412' });
    assert.equal(parseHubMessage({ command: 'openPr' }), undefined);
    assert.equal(parseHubMessage({ command: 'openPr', pr: '' }), undefined);
    assert.equal(parseHubMessage({ command: 'openPr', pr: 5 }), undefined);
  });

  it('never accepts a URL from the page: openPr only carries an id the extension looks up itself', () => {
    const msg = parseHubMessage({ command: 'openPr', pr: '/w/billing#412', url: 'https://evil.example' });
    assert.deepEqual(msg, { command: 'openPr', pr: '/w/billing#412' });
  });
});
