import { strict as assert } from 'assert';
import * as path from 'path';
import { Session } from '../../src/sessions/model';
import { TimeEvent, TimeEventType } from '../../src/time/events';
import { buildReport, formatDuration, localDays, renderCsv, renderMarkdown, ReportOptions } from '../../src/time/report';
import { eventsForStatusChange, sessionForPath, ticketKey } from '../../src/time/rules';

const MIN = 60_000;

function session(id: string, worktree: string, extra: Partial<Session> = {}): Session {
  return { id, repo: '/r', worktree, branch: `wb/${id}`, baseRef: 'main', createdAt: 't', ...extra };
}

describe('time-tracking', () => {
  describe('ticketKey', () => {
    it('books ticket sessions under source:id and ad-hoc sessions under their own id', () => {
      assert.equal(ticketKey(session('github-42-1', '/w', { ticket: { source: 'GitHub', id: '42', title: 'T' } })), 'GitHub:42');
      assert.equal(ticketKey(session('adhoc-spike-1', '/w', { title: 'Spike' })), 'adhoc:adhoc-spike-1');
    });
  });

  describe('sessionForPath', () => {
    const root = path.resolve('/wt');
    const a = session('a-1', path.join(root, 'a-1'));
    const b = session('a-10', path.join(root, 'a-10'));

    it('finds the session whose worktree contains the file', () => {
      assert.equal(sessionForPath([a, b], path.join(root, 'a-1', 'src', 'x.ts'), false), a);
      assert.equal(sessionForPath([a, b], path.join(root, 'a-10', 'x.ts'), false), b);
    });

    it('does not match a sibling folder that merely shares a prefix', () => {
      assert.equal(sessionForPath([a], path.join(root, 'a-10', 'x.ts'), false), undefined);
    });

    it('matches the worktree folder itself and ignores files elsewhere', () => {
      assert.equal(sessionForPath([a], path.join(root, 'a-1'), false), a);
      assert.equal(sessionForPath([a], path.resolve('/elsewhere/x.ts'), false), undefined);
    });

    it('ignores case when asked to (Windows paths)', () => {
      assert.equal(sessionForPath([a], path.join(root, 'A-1', 'X.ts').toUpperCase(), true), a);
      assert.equal(sessionForPath([a], path.join(root, 'A-1', 'X.ts').toUpperCase(), false), undefined);
    });
  });

  describe('eventsForStatusChange', () => {
    it('starts agent time when the agent starts working', () => {
      assert.deepEqual(eventsForStatusChange(undefined, 'working'), ['agent-working']);
      assert.deepEqual(eventsForStatusChange('exited', 'working'), ['agent-working']);
    });

    it('also counts your activity when work resumes after the agent waited on you', () => {
      assert.deepEqual(eventsForStatusChange('done', 'working'), ['agent-working', 'activity']);
      assert.deepEqual(eventsForStatusChange('needs-input', 'working'), ['agent-working', 'activity']);
    });

    it('stops agent time when it waits, finishes or exits', () => {
      for (const next of ['needs-input', 'done', 'exited'] as const) {
        assert.deepEqual(eventsForStatusChange('working', next), ['agent-idle'], next);
      }
    });

    it('emits nothing when the state does not change or between non-working states', () => {
      assert.deepEqual(eventsForStatusChange('working', 'working'), []);
      assert.deepEqual(eventsForStatusChange('done', 'needs-input'), []);
      assert.deepEqual(eventsForStatusChange(undefined, undefined), []);
    });
  });

  describe('formatDuration', () => {
    it('shows minutes, then hours with zero-padded minutes', () => {
      assert.equal(formatDuration(0), '0m');
      assert.equal(formatDuration(59_999), '0m');
      assert.equal(formatDuration(45 * MIN), '45m');
      assert.equal(formatDuration(65 * MIN), '1h 05m');
      assert.equal(formatDuration(600 * MIN), '10h 00m');
    });
  });

  describe('localDays', () => {
    it('returns each local calendar day from midnight to midnight, inclusive of both ends', () => {
      const days = localDays(new Date(2026, 10, 2, 15), new Date(2026, 10, 4, 1));
      assert.deepEqual(days.map((d) => d.label), ['2026-11-02', '2026-11-03', '2026-11-04']);
      assert.equal(days[0].start, new Date(2026, 10, 2).getTime());
      assert.equal(days[0].end, new Date(2026, 10, 3).getTime());
      assert.equal(days[2].end, new Date(2026, 10, 5).getTime());
    });
  });

  describe('report', () => {
    const DAY1 = { label: '2026-11-04', start: Date.parse('2026-11-04T00:00:00Z'), end: Date.parse('2026-11-05T00:00:00Z') };
    const DAY2 = { label: '2026-11-05', start: DAY1.end, end: DAY1.end + 1440 * MIN };
    const opts: ReportOptions = { idleMs: 5 * MIN, booked: 'elapsed', roundToMinutes: 15 };
    const at = (iso: string, type: TimeEventType, ticket = 'GitHub:42', session = 's'): TimeEvent => ({ ts: iso, ticket, session, type });
    const events = [
      at('2026-11-04T09:00:00Z', 'agent-working'),
      at('2026-11-04T09:20:00Z', 'agent-idle'),
      at('2026-11-04T10:00:00Z', 'agent-working', 'Jira:P-1', 's2'),
      at('2026-11-04T10:07:00Z', 'agent-idle', 'Jira:P-1', 's2'),
      at('2026-11-05T09:00:00Z', 'agent-working'),
      at('2026-11-05T09:01:00Z', 'agent-idle'),
    ];
    const titles = { 'GitHub:42': 'Crash, "empty" config', 'Jira:P-1': 'Export CSV' };

    it('builds one row per ticket per day with the booked figure rounded up', () => {
      const rows = buildReport(events, [DAY1, DAY2], titles, opts);
      assert.deepEqual(
        rows.map((r) => [r.day, r.ticket, r.title, r.agentMs / MIN, r.elapsedMs / MIN, r.bookedMs / MIN]),
        [
          ['2026-11-04', 'GitHub:42', 'Crash, "empty" config', 20, 20, 30],
          ['2026-11-04', 'Jira:P-1', 'Export CSV', 7, 7, 15],
          ['2026-11-05', 'GitHub:42', 'Crash, "empty" config', 1, 1, 15],
        ],
      );
    });

    it('books the configured figure', () => {
      const rows = buildReport(events, [DAY1], titles, { ...opts, booked: 'your' });
      assert.deepEqual(rows.map((r) => r.bookedMs), [0, 0]);
    });

    it('falls back to the ticket key when no title is known', () => {
      assert.equal(buildReport(events, [DAY1], {}, opts)[0].title, 'GitHub:42');
    });

    it('renders CSV with whole minutes and properly quoted titles', () => {
      const csv = renderCsv(buildReport(events, [DAY1], titles, opts));
      assert.equal(
        csv,
        [
          'date,ticket,title,your_minutes,agent_minutes,elapsed_minutes,booked_minutes',
          '2026-11-04,GitHub:42,"Crash, ""empty"" config",0,20,20,30',
          '2026-11-04,Jira:P-1,Export CSV,0,7,7,15',
          '',
        ].join('\n'),
      );
    });

    it('renders a Markdown table per day with a day total and the booking rule in the header', () => {
      const md = renderMarkdown(buildReport(events, [DAY1], titles, opts), opts);
      assert.match(md, /^## 2026-11-04$/m);
      assert.match(md, /Booked \(elapsed, rounded up to 15m\)/);
      assert.match(md, /\| GitHub:42 \| Crash, "empty" config \| 0m \| 20m \| 20m \| 30m \|/);
      assert.match(md, /\| \*\*Total\*\* \| \| 0m \| 27m \| 27m \| 45m \|/);
    });

    it('says so when there is nothing to report', () => {
      assert.match(renderMarkdown([], opts), /No time recorded/);
    });
  });
});
