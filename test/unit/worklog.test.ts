import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReportView, parseReportMessage, renderTimeReport, reportPeriod } from '../../src/report/view';
import { ReportRow } from '../../src/time/report';
import { appendLedger, logStatus, readLedger, runLogCommand, worklogEnv } from '../../src/worklog/worklog';

const MIN = 60_000;
const fixtures = path.join(__dirname, '..', 'fixtures');

function row(ticket: string, bookedMin: number, day = '2026-11-04'): ReportRow {
  return { day, ticket, title: 't', yourMs: 0, agentMs: bookedMin * MIN, elapsedMs: bookedMin * MIN, bookedMs: bookedMin * MIN };
}

describe('worklog', function () {
  this.timeout(20000);

  describe('logStatus', () => {
    const sources = new Set(['Jira']);
    const ledger = [{ ticket: 'Jira:PROJ-1', day: '2026-11-04', minutes: 60, loggedAt: 't' }];

    it('is pending for a ticket of a source with a log command that was not logged yet', () => {
      assert.deepEqual(logStatus(row('Jira:PROJ-2', 45), ledger, sources), { kind: 'pending', minutes: 45 });
    });

    it('is logged when the ledger has the same ticket, day and minutes', () => {
      assert.deepEqual(logStatus(row('Jira:PROJ-1', 60), ledger, sources), { kind: 'logged', minutes: 60 });
    });

    it('flags a change when more time was booked after logging, and never logs twice automatically', () => {
      assert.deepEqual(logStatus(row('Jira:PROJ-1', 90), ledger, sources), { kind: 'changed', loggedMinutes: 60, minutes: 90 });
    });

    it('sums several ledger entries of the same day (e.g. a later top-up)', () => {
      const twice = [...ledger, { ticket: 'Jira:PROJ-1', day: '2026-11-04', minutes: 30, loggedAt: 't2' }];
      assert.deepEqual(logStatus(row('Jira:PROJ-1', 90), twice, sources), { kind: 'logged', minutes: 90 });
    });

    it('does not mix days', () => {
      assert.deepEqual(logStatus(row('Jira:PROJ-1', 60, '2026-11-05'), ledger, sources), { kind: 'pending', minutes: 60 });
    });

    it('knows when there is no log command or no ticket at all', () => {
      assert.deepEqual(logStatus(row('GitHub:42', 30), ledger, sources), { kind: 'no-command' });
      assert.deepEqual(logStatus(row('adhoc:adhoc-spike-1', 30), ledger, sources), { kind: 'no-ticket' });
    });

    it('rounds booked time to whole minutes', () => {
      assert.deepEqual(logStatus({ ...row('Jira:PROJ-2', 0), bookedMs: 44.6 * MIN }, ledger, sources), { kind: 'pending', minutes: 45 });
    });
  });

  describe('ledger file', () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ledger-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('appends entries and reads them back; a missing file is an empty ledger', () => {
      const file = path.join(dir, 'sub', 'worklog.jsonl');
      assert.deepEqual(readLedger(file), []);
      const e = { ticket: 'Jira:PROJ-1', day: '2026-11-04', minutes: 60, loggedAt: '2026-11-04T17:00:00.000Z' };
      appendLedger(file, e);
      appendLedger(file, { ...e, minutes: 15 });
      assert.deepEqual(readLedger(file), [e, { ...e, minutes: 15 }]);
    });

    it('skips unreadable lines', () => {
      const file = path.join(dir, 'worklog.jsonl');
      fs.writeFileSync(file, '{broken\n{"ticket":"Jira:P","day":"2026-11-04","minutes":5,"loggedAt":"t"}\n{"ticket":1}\n');
      assert.deepEqual(readLedger(file), [{ ticket: 'Jira:P', day: '2026-11-04', minutes: 5, loggedAt: 't' }]);
    });
  });

  describe('worklogEnv + runLogCommand', () => {
    const entry = { ticket: 'Jira:PROJ-123', day: '2026-11-04', minutes: 75, note: 'Export: "csv"; echo pwned & del x' };

    it('passes ticket, date, minutes and note as WB_* variables', () => {
      assert.deepEqual(worklogEnv(entry), {
        WB_TICKET: 'Jira:PROJ-123',
        WB_TICKET_SOURCE: 'Jira',
        WB_TICKET_ID: 'PROJ-123',
        WB_DATE: '2026-11-04',
        WB_MINUTES: '75',
        WB_SECONDS: '4500',
        WB_NOTE: 'Export: "csv"; echo pwned & del x',
      });
    });

    it('keeps ids that contain a colon intact', () => {
      assert.equal(worklogEnv({ ...entry, ticket: 'GitLab:group/proj:12' }).WB_TICKET_ID, 'group/proj:12');
    });

    it('runs the command with those variables; the note stays data, never shell input', async () => {
      const out = await runLogCommand(`node "${path.join(fixtures, 'print-env.js')}"`, entry, fixtures);
      const env = JSON.parse(out);
      assert.equal(env.WB_NOTE, entry.note);
      assert.equal(env.WB_TICKET_ID, 'PROJ-123');
      assert.ok(!out.includes('\npwned'), 'note was executed');
    });

    it('rejects with the command\'s error output', async () => {
      await assert.rejects(runLogCommand(`node "${path.join(fixtures, 'fail.js')}"`, entry, fixtures), /not logged in/);
    });
  });

  describe('report integration', () => {
    const NOW = new Date(2026, 10, 4, 15);
    const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).toISOString();
    const events = [
      { ts: at(9), ticket: 'Jira:PROJ-1', session: 's1', type: 'agent-working' as const },
      { ts: at(10), ticket: 'Jira:PROJ-1', session: 's1', type: 'agent-idle' as const },
      { ts: at(11), ticket: 'Jira:PROJ-2', session: 's2', type: 'agent-working' as const },
      { ts: at(11, 30), ticket: 'Jira:PROJ-2', session: 's2', type: 'agent-idle' as const },
    ];
    const opts = { idleMs: 5 * MIN, booked: 'elapsed' as const, roundToMinutes: 15 };
    const state = { period: 'today' as const, booked: 'elapsed' as const, roundToMinutes: 15 };
    const ledger = [{ ticket: 'Jira:PROJ-1', day: '2026-11-04', minutes: 60, loggedAt: 't' }];
    const status = (r: ReportRow) => logStatus(r, ledger, new Set(['Jira']));

    it('shows a Logged column and enables "Log to tracker" while something is pending', () => {
      const view = buildReportView(events, reportPeriod('today', NOW), {}, opts, NOW, status);
      assert.deepEqual(view.days[0].rows.map((r) => r.log?.kind), ['logged', 'pending']);
      assert.equal(view.pendingCount, 1);
      const html = renderTimeReport(view, state, 'n', 'csp');
      assert.match(html, /<th>Logged<\/th>/);
      assert.match(html, /✓ logged/);
      assert.match(html, /not yet/);
      assert.match(html, /id="log"[^>]*>Log to tracker… \(1\)</);
    });

    it('disables "Log to tracker" when nothing is pending', () => {
      const all = (r: ReportRow) => logStatus(r, [...ledger, { ticket: 'Jira:PROJ-2', day: '2026-11-04', minutes: 30, loggedAt: 't' }], new Set(['Jira']));
      const html = renderTimeReport(buildReportView(events, reportPeriod('today', NOW), {}, opts, NOW, all), state, 'n', 'csp');
      assert.match(html, /id="log"[^>]*disabled/);
    });

    it('accepts the logWork message', () => {
      assert.deepEqual(parseReportMessage({ command: 'logWork' }), { command: 'logWork' });
    });
  });
});
