import { strict as assert } from 'assert';
import { buildReportView, isoWeek, parseReportMessage, renderTimeReport, reportPeriod, ReportState } from '../../src/report/view';
import { TimeEvent, TimeEventType } from '../../src/time/events';

const MIN = 60_000;
// Local dates only, so the tests hold in any time zone. Wed 4 Nov 2026 is "today".
const NOW = new Date(2026, 10, 4, 15, 0);
const day = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min).toISOString();
const ev = (ts: string, type: TimeEventType, ticket = 'Jira:PROJ-123', session = 's1'): TimeEvent => ({ ts, ticket, session, type });
const opts = { idleMs: 5 * MIN, booked: 'elapsed' as const, roundToMinutes: 15 };

describe('report-view', () => {
  describe('reportPeriod', () => {
    it('gives local calendar ranges with Monday-based weeks', () => {
      const p = (id: Parameters<typeof reportPeriod>[0]) => {
        const r = reportPeriod(id, NOW);
        return [day(r.from), day(r.to)];
      };
      assert.deepEqual(p('today'), [[2026, 11, 4], [2026, 11, 4]]);
      assert.deepEqual(p('yesterday'), [[2026, 11, 3], [2026, 11, 3]]);
      assert.deepEqual(p('thisWeek'), [[2026, 11, 2], [2026, 11, 8]]);
      assert.deepEqual(p('lastWeek'), [[2026, 10, 26], [2026, 11, 1]]);
      assert.deepEqual(p('thisMonth'), [[2026, 11, 1], [2026, 11, 30]]);
    });

    it('treats Sunday as the end of its week', () => {
      const r = reportPeriod('thisWeek', new Date(2026, 10, 8, 12));
      assert.deepEqual([day(r.from), day(r.to)], [[2026, 11, 2], [2026, 11, 8]]);
    });
  });

  describe('isoWeek', () => {
    it('follows ISO 8601, including week 53 and year boundaries', () => {
      assert.equal(isoWeek(new Date(2026, 10, 4)), 45);
      assert.equal(isoWeek(new Date(2027, 0, 1)), 53); // Friday: still the last week of 2026
      assert.equal(isoWeek(new Date(2026, 0, 1)), 1); // Thursday: week 1
      assert.equal(isoWeek(new Date(2025, 11, 29)), 1); // Monday of 2026's week 1
    });
  });

  describe('buildReportView', () => {
    const events = [
      ev(at(11, 3, 10), 'agent-working'),
      ev(at(11, 3, 11, 20), 'agent-idle'), // Tue: 80m → booked 90m
      ev(at(11, 4, 9), 'agent-working', 'GitHub:42', 's2'),
      ev(at(11, 4, 9, 25), 'agent-idle', 'GitHub:42', 's2'), // Wed: 25m → 30m
      ev(at(10, 30, 9), 'agent-working'),
      ev(at(10, 30, 10), 'agent-idle'), // last week: outside
    ];
    const titles = { 'Jira:PROJ-123': 'Export report as CSV', 'GitHub:42': 'Crash on empty config' };

    it('groups rows per day, leaves out days without time, and totals days and the period', () => {
      const v = buildReportView(events, reportPeriod('thisWeek', NOW), titles, opts, NOW);
      assert.deepEqual(
        v.days.map((d) => [d.label, d.isToday, d.rows.map((r) => r.ticket), d.totals.elapsedMs / MIN, d.totals.bookedMs / MIN]),
        [
          ['Tue, Nov 3', false, ['Jira:PROJ-123'], 80, 90],
          ['Wed, Nov 4', true, ['GitHub:42'], 25, 30],
        ],
      );
      assert.deepEqual([v.totals.elapsedMs / MIN, v.totals.agentMs / MIN, v.totals.yourMs / MIN, v.totals.bookedMs / MIN], [105, 105, 0, 120]);
      assert.equal(v.ticketCount, 2);
      assert.equal(v.eventCount, 4);
    });

    it('titles weeks by ISO number and range, single days by name', () => {
      assert.equal(buildReportView(events, reportPeriod('thisWeek', NOW), titles, opts, NOW).title, 'Week 45 · Nov 2 – Nov 8');
      assert.equal(buildReportView(events, reportPeriod('today', NOW), titles, opts, NOW).title, 'Today · Wed, Nov 4');
      assert.equal(buildReportView(events, reportPeriod('yesterday', NOW), titles, opts, NOW).title, 'Yesterday · Tue, Nov 3');
      assert.equal(buildReportView(events, reportPeriod('thisMonth', NOW), titles, opts, NOW).title, 'November 2026');
    });

    it('is empty for a period without time', () => {
      const v = buildReportView([], reportPeriod('today', NOW), titles, opts, NOW);
      assert.deepEqual(v.days, []);
      assert.equal(v.ticketCount, 0);
    });
  });

  describe('renderTimeReport', () => {
    const state: ReportState = { period: 'thisWeek', booked: 'your', roundToMinutes: 30 };
    const view = () =>
      buildReportView(
        [ev(at(11, 4, 9), 'agent-working'), ev(at(11, 4, 9, 30), 'agent-idle')],
        reportPeriod('thisWeek', NOW),
        { 'Jira:PROJ-123': '<script>alert(1)</script> & "quotes"' },
        opts,
        NOW,
      );

    it('escapes ticket titles', () => {
      const html = renderTimeReport(view(), state, 'n0nce', 'csp');
      assert.ok(!html.includes('<script>alert(1)'));
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
    });

    it('reflects the current state in the controls', () => {
      const html = renderTimeReport(view(), state, 'n', 'csp');
      assert.match(html, /data-period="thisWeek"[^>]*aria-checked="true"/);
      assert.match(html, /data-period="today"[^>]*aria-checked="false"/);
      assert.match(html, /<option value="your" selected>/);
      assert.match(html, /<option value="30" selected>/);
    });

    it('runs scripts only with the nonce', () => {
      const html = renderTimeReport(view(), state, 'n0nce', 'csp');
      assert.match(html, /default-src 'none'/);
      for (const tag of html.match(/<script[^>]*>/g) ?? []) {
        assert.match(tag, /nonce="n0nce"/);
      }
    });

    it('says so when there is nothing to report', () => {
      const empty = buildReportView([], reportPeriod('today', NOW), {}, opts, NOW);
      assert.match(renderTimeReport(empty, state, 'n', 'csp'), /No time recorded/);
    });
  });

  describe('parseReportMessage', () => {
    it('accepts valid control changes and rejects everything else', () => {
      assert.deepEqual(parseReportMessage({ command: 'setPeriod', period: 'lastWeek' }), { command: 'setPeriod', period: 'lastWeek' });
      assert.deepEqual(parseReportMessage({ command: 'setBooked', booked: 'agent' }), { command: 'setBooked', booked: 'agent' });
      assert.deepEqual(parseReportMessage({ command: 'setRounding', roundToMinutes: '15' }), { command: 'setRounding', roundToMinutes: 15 });
      assert.deepEqual(parseReportMessage({ command: 'copyCsv' }), { command: 'copyCsv' });
      assert.equal(parseReportMessage({ command: 'setPeriod', period: 'forever' }), undefined);
      assert.equal(parseReportMessage({ command: 'setBooked', booked: 'all' }), undefined);
      assert.equal(parseReportMessage({ command: 'setRounding', roundToMinutes: 7 }), undefined);
      assert.equal(parseReportMessage({ command: 'deleteLog' }), undefined);
    });
  });
});
