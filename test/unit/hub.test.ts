import { strict as assert } from 'assert';
import { buildTicketHub, HubInput, HubModel } from '../../src/hub/model';
import { parseHubMessage, renderTicketHub } from '../../src/hub/render';
import { Session } from '../../src/sessions/model';
import { ticketIntervals } from '../../src/time/compute';
import { TimeEvent, TimeEventType } from '../../src/time/events';
import { localDays } from '../../src/time/report';
import { mapTickets } from '../../src/tickets/source';

const MIN = 60_000;
// Local dates throughout, so the tests hold in any time zone. Wed 4 Nov 2026 is "today".
const NOW = new Date(2026, 10, 4, 15, 0);
const WEEK = localDays(new Date(2026, 10, 2), new Date(2026, 10, 8));
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).toISOString();
const ev = (ts: string, type: TimeEventType, session = 'jira-proj-123-1', ticket = 'Jira:PROJ-123'): TimeEvent => ({ ts, ticket, session, type });

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, repo: '/r', worktree: `/w/${id}`, branch: `wb/${id}`, baseRef: 'main', createdAt: 't', ticket: { source: 'Jira', id: 'PROJ-123', title: 'Export' }, ...extra };
}

function input(extra: Partial<HubInput> = {}): HubInput {
  return {
    ticket: { key: 'Jira:PROJ-123', source: 'Jira', id: 'PROJ-123', title: 'Export report as CSV', status: 'In Progress', url: 'https://jira/PROJ-123', listed: true },
    sessions: [session('jira-proj-123-1', { agent: 'claude' }), session('jira-proj-123-2', { agent: 'codex' })],
    statuses: {
      'jira-proj-123-1': { state: 'needs-input', at: at(4, 15, 0), since: at(4, 15, 0), message: 'Bash: npm test' },
      'jira-proj-123-2': { state: 'working', at: at(4, 14, 59), since: at(4, 14, 56) },
    },
    changes: { 'jira-proj-123-1': { files: 3, added: 161, removed: 4 } },
    events: [
      // Tue: agent 10:00–11:15 (75m)
      ev(at(3, 10, 0), 'agent-working'),
      ev(at(3, 11, 15), 'agent-idle'),
      // Wed: agent 9:00–10:00, you 9:30–9:40 (heartbeats) → elapsed 60m, you 10m
      ev(at(4, 9, 0), 'agent-working'),
      ev(at(4, 9, 30), 'focus-start'),
      ev(at(4, 9, 34), 'activity'),
      ev(at(4, 9, 38), 'activity'),
      ev(at(4, 9, 40), 'focus-end'),
      ev(at(4, 10, 0), 'agent-idle'),
      // another ticket, must not count
      ev(at(4, 11, 0), 'agent-working', 's9', 'GitHub:42'),
      ev(at(4, 12, 0), 'agent-idle', 's9', 'GitHub:42'),
    ],
    week: WEEK,
    now: NOW,
    opts: { idleMs: 5 * MIN, booked: 'elapsed', roundToMinutes: 15 },
    ...extra,
  };
}

describe('hub', () => {
  describe('ticketIntervals', () => {
    it('returns merged, clipped intervals per ticket for you and agents', () => {
      const day = WEEK[2];
      const ivs = ticketIntervals(input().events, day, { idleMs: 5 * MIN })['Jira:PROJ-123'];
      assert.deepEqual(ivs.agents, [[Date.parse(at(4, 9, 0)), Date.parse(at(4, 10, 0))]]);
      assert.deepEqual(ivs.you, [[Date.parse(at(4, 9, 30)), Date.parse(at(4, 9, 40))]]);
    });
  });

  describe('buildTicketHub', () => {
    it('lists sessions with agent, state, time in state, message and change summary', () => {
      const m = buildTicketHub(input());
      assert.deepEqual(m.sessions, [
        { id: 'jira-proj-123-1', agent: 'claude', branch: 'wb/jira-proj-123-1', state: 'needs-input', since: 'now', message: 'Bash: npm test', files: 3, added: 161, removed: 4 },
        { id: 'jira-proj-123-2', agent: 'codex', branch: 'wb/jira-proj-123-2', state: 'working', since: '4m', message: undefined, files: 0, added: 0, removed: 0 },
      ]);
    });

    it('sums this week for this ticket only, booking the rounded figure per day', () => {
      const { week } = buildTicketHub(input());
      assert.equal(week.elapsedMs / MIN, 75 + 60);
      assert.equal(week.agentMs / MIN, 135);
      assert.equal(week.yourMs / MIN, 10);
      assert.equal(week.bookedMs / MIN, 75 + 60); // both already whole 15-minute blocks
    });

    it('rounds each day separately (two days of 1 minute book 30 minutes, not 15)', () => {
      const events = [ev(at(2, 9, 0), 'agent-working'), ev(at(2, 9, 1), 'agent-idle'), ev(at(3, 9, 0), 'agent-working'), ev(at(3, 9, 1), 'agent-idle')];
      assert.equal(buildTicketHub(input({ events })).week.bookedMs / MIN, 30);
    });

    it('gives one bar per day Mon..Sun with today marked', () => {
      const { days } = buildTicketHub(input());
      assert.deepEqual(days.map((d) => [d.label, d.elapsedMs / MIN, d.isToday]), [
        ['Mon', 0, false],
        ['Tue', 75, false],
        ['Wed', 60, true],
        ['Thu', 0, false],
        ['Fri', 0, false],
        ['Sat', 0, false],
        ['Sun', 0, false],
      ]);
    });

    it('draws today\'s timeline as fractions of a window covering at least 08:00–18:00', () => {
      const { timeline } = buildTicketHub(input());
      const span = 10 * 60; // minutes 08:00–18:00
      assert.deepEqual(timeline.agents, [[60 / span, 120 / span]]);
      assert.deepEqual(timeline.you, [[90 / span, 100 / span]]);
      assert.deepEqual(timeline.hours.map((h) => h.label), ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00']);
      assert.equal(timeline.hours[0].at, 0);
      assert.equal(timeline.hours[5].at, 1);
    });

    it('widens the window to include work outside 08:00–18:00', () => {
      const events = [ev(at(4, 6, 0), 'agent-working'), ev(at(4, 7, 0), 'agent-idle')];
      const { timeline } = buildTicketHub(input({ events }));
      assert.equal(timeline.hours[0].label, '06:00');
      assert.deepEqual(timeline.agents, [[0, 60 / (12 * 60)]]);
    });

    it('handles a ticket without sessions or time', () => {
      const m = buildTicketHub(input({ sessions: [], statuses: {}, changes: {}, events: [] }));
      assert.deepEqual(m.sessions, []);
      assert.deepEqual(m.week, { yourMs: 0, agentMs: 0, elapsedMs: 0, bookedMs: 0 });
      assert.deepEqual(m.timeline.you, []);
    });
  });

  describe('renderTicketHub', () => {
    const model = (patch: Partial<HubModel['ticket']> = {}): HubModel => {
      const m = buildTicketHub(input());
      return { ...m, ticket: { ...m.ticket, ...patch } };
    };

    it('escapes tracker text everywhere it appears', () => {
      const html = renderTicketHub(model({ title: '<img src=x onerror=alert(1)>', description: '"><script>alert(2)</script>', status: '<b>x</b>' }), 'n0nce', 'vscode-resource:');
      assert.ok(!html.includes('<img src=x'), 'title not escaped');
      assert.ok(!html.includes('<script>alert(2)'), 'description not escaped');
      assert.ok(!html.includes('<b>x</b>'), 'status not escaped');
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    it('locks scripts to the nonce and allows nothing else from outside', () => {
      const html = renderTicketHub(model(), 'n0nce', 'vscode-resource:');
      assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/);
      assert.match(html, /script-src 'nonce-n0nce'/);
      const scripts = html.match(/<script[^>]*>/g) ?? [];
      assert.ok(scripts.length > 0);
      for (const tag of scripts) {
        assert.match(tag, /nonce="n0nce"/);
      }
    });

    it('offers per-session actions and disables "Work on this" for tickets no longer listed', () => {
      assert.match(renderTicketHub(model(), 'n', 'c'), /data-command="openAgent" data-session="jira-proj-123-1"/);
      assert.match(renderTicketHub(model({ listed: false }), 'n', 'c'), /data-command="newSession"[^>]*disabled/);
    });

    it('omits "Open in tracker" without a url', () => {
      assert.ok(!renderTicketHub(model({ url: undefined }), 'n', 'c').includes('data-command="openInBrowser"'));
    });
  });

  describe('parseHubMessage', () => {
    it('accepts known commands and rejects anything else', () => {
      assert.deepEqual(parseHubMessage({ command: 'openAgent', session: 's-1' }), { command: 'openAgent', session: 's-1' });
      assert.deepEqual(parseHubMessage({ command: 'newSession' }), { command: 'newSession' });
      assert.equal(parseHubMessage({ command: 'openAgent' }), undefined);
      assert.equal(parseHubMessage({ command: 'runShell', cmd: 'rm -rf /' }), undefined);
      assert.equal(parseHubMessage('openAgent'), undefined);
    });
  });

  describe('ticket description mapping', () => {
    it('maps an optional description path and leaves the key out when not configured', () => {
      const cfg = { name: 'Jira', listCmd: 'x', map: { id: 'key', title: 'fields.summary', description: 'fields.description' } };
      const [t] = mapTickets([{ key: 'P-1', fields: { summary: 'S', description: 'Long text' } }], cfg);
      assert.equal(t.description, 'Long text');
      const [plain] = mapTickets([{ key: 'P-1', fields: { summary: 'S' } }], { ...cfg, map: { id: 'key', title: 'fields.summary' } });
      assert.ok(!('description' in plain));
    });
  });
});
