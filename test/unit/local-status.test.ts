import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTicketHub, HubInput } from '../../src/hub/model';
import { parseHubMessage, renderTicketHub } from '../../src/hub/render';
import { buildReportView, parseReportMessage, renderTimeReport, reportPeriod } from '../../src/report/view';
import { Session } from '../../src/sessions/model';
import { appendEntered, entryStatus, isOpen, minutesToEnter, readEntered } from '../../src/time/booking';
import { ReportRow } from '../../src/time/report';
import { Ticket } from '../../src/tickets/source';
import { statusAfter, WorkflowStore, WorkStatus } from '../../src/tickets/workflow';
import { filterWork, groupWork } from '../../src/ui/group';

const MIN = 60_000;

describe('local-status', () => {
  describe('statusAfter', () => {
    it('moves to Doing when a session starts, from any other status', () => {
      assert.equal(statusAfter('todo', 'session-started'), 'doing');
      assert.equal(statusAfter('review', 'session-started'), 'doing');
      assert.equal(statusAfter('done', 'session-started'), 'doing');
      assert.equal(statusAfter('doing', 'session-started'), undefined);
    });

    it('moves to Review when a PR is created, but never back from Done', () => {
      assert.equal(statusAfter('todo', 'pr-created'), 'review');
      assert.equal(statusAfter('doing', 'pr-created'), 'review');
      assert.equal(statusAfter('review', 'pr-created'), undefined);
      assert.equal(statusAfter('done', 'pr-created'), undefined);
    });
  });

  describe('WorkflowStore', () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-flow-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('defaults to To do and persists changes', () => {
      const file = path.join(dir, 'ticket-status.json');
      const a = new WorkflowStore(file);
      assert.equal(a.get('Jira:PROJ-1'), 'todo');
      a.set('Jira:PROJ-1', 'review');
      assert.equal(new WorkflowStore(file).get('Jira:PROJ-1'), 'review');
      assert.equal(new WorkflowStore(file).get('Jira:PROJ-2'), 'todo');
    });

    it('treats a corrupt file as empty, warns, and keeps a backup', () => {
      const file = path.join(dir, 'ticket-status.json');
      fs.writeFileSync(file, '{nope');
      const store = new WorkflowStore(file);
      assert.equal(store.get('Jira:PROJ-1'), 'todo');
      assert.match(store.warning ?? '', /ticket-status\.json/);
      assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('ticket-status.json.corrupt-')).length, 1);
    });

    it('ignores unknown status values in the file', () => {
      const file = path.join(dir, 'ticket-status.json');
      fs.writeFileSync(file, JSON.stringify({ 'Jira:PROJ-1': 'blocked', 'Jira:PROJ-2': 'done' }));
      const store = new WorkflowStore(file);
      assert.equal(store.get('Jira:PROJ-1'), 'todo');
      assert.equal(store.get('Jira:PROJ-2'), 'done');
    });
  });

  describe('filterWork with workbench status', () => {
    const cfg = { name: 'Jira', listCmd: 'x', map: { id: 'key', title: 'summary' } };
    const tk = (id: string, title: string): Ticket => ({ source: 'Jira', id, title, raw: {} });
    const snap = { source: 'Jira', fetchedAt: 't', tickets: [tk('P-1', 'Export'), tk('P-2', 'Login'), tk('P-3', 'Dark mode')] };
    const running: Session = { id: 'jira-p-3-1', repo: '/r', worktree: '/w', branch: 'b', baseRef: 'main', createdAt: 't', ticket: { source: 'Jira', id: 'P-3', title: 'Dark mode' } };
    const statuses: Record<string, WorkStatus> = { 'Jira:P-1': 'done', 'Jira:P-2': 'review', 'Jira:P-3': 'done' };
    const workStatus = (key: string) => statuses[key] ?? 'todo';
    const ids = (text: string, hideDone = false) =>
      filterWork(groupWork([cfg], [snap], [running]), text, { workStatus, hideDone }).sources[0].tickets.map((g) => g.ticket.id);

    it('matches the workbench status label', () => {
      assert.deepEqual(ids('review'), ['P-2', 'P-3']); // P-3 stays: it has a session
      assert.deepEqual(ids('done'), ['P-1', 'P-3']);
    });

    it('hides Done tickets on request, keeping those with sessions', () => {
      assert.deepEqual(ids('', true), ['P-2', 'P-3']);
    });
  });

  describe('booking marks', () => {
    const row = (ticket: string, min: number, day = '2026-11-04'): ReportRow => ({ day, ticket, title: 't', yourMs: 0, agentMs: 0, elapsedMs: min * MIN, bookedMs: min * MIN });
    const entered = [{ ticket: 'Jira:P-1', day: '2026-11-04', minutes: 60, at: 't' }];

    it('is open until marked, entered when the minutes match, changed when they differ', () => {
      assert.deepEqual(entryStatus(row('Jira:P-2', 45), entered), { kind: 'open', minutes: 45 });
      assert.deepEqual(entryStatus(row('Jira:P-1', 60), entered), { kind: 'entered', minutes: 60 });
      assert.deepEqual(entryStatus(row('Jira:P-1', 90), entered), { kind: 'changed', enteredMinutes: 60, minutes: 90 });
      assert.deepEqual(entryStatus(row('Jira:P-1', 60, '2026-11-05'), entered), { kind: 'open', minutes: 60 });
    });

    it('works for ad-hoc work too: you may book it under any code', () => {
      assert.deepEqual(entryStatus(row('adhoc:adhoc-spike-1', 30), entered), { kind: 'open', minutes: 30 });
    });

    it('offers open rows and growth only, and says how much is left to enter', () => {
      assert.equal(isOpen({ kind: 'open', minutes: 15 }), true);
      assert.equal(isOpen({ kind: 'changed', enteredMinutes: 60, minutes: 90 }), true);
      assert.equal(isOpen({ kind: 'changed', enteredMinutes: 90, minutes: 60 }), false);
      assert.equal(isOpen({ kind: 'entered', minutes: 60 }), false);
      assert.equal(minutesToEnter({ kind: 'open', minutes: 15 }), 15);
      assert.equal(minutesToEnter({ kind: 'changed', enteredMinutes: 60, minutes: 90 }), 30);
    });

    it('stores marks append-only and skips unreadable lines', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-entered-'));
      try {
        const file = path.join(dir, 'sub', 'entered.jsonl');
        assert.deepEqual(readEntered(file), []);
        appendEntered(file, entered[0]);
        fs.appendFileSync(file, '{broken\n');
        assert.deepEqual(readEntered(file), entered);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('time report "Entered" column', () => {
    const NOW = new Date(2026, 10, 4, 15);
    const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).toISOString();
    const events = [
      { ts: at(9), ticket: 'Jira:P-1', session: 's1', type: 'agent-working' as const },
      { ts: at(10), ticket: 'Jira:P-1', session: 's1', type: 'agent-idle' as const },
      { ts: at(11), ticket: 'Jira:P-2', session: 's2', type: 'agent-working' as const },
      { ts: at(11, 30), ticket: 'Jira:P-2', session: 's2', type: 'agent-idle' as const },
    ];
    const opts = { idleMs: 5 * MIN, booked: 'elapsed' as const, roundToMinutes: 15 };
    const state = { period: 'today' as const, booked: 'elapsed' as const, roundToMinutes: 15 };
    const view = (entered: { ticket: string; day: string; minutes: number; at: string }[]) =>
      buildReportView(events, reportPeriod('today', NOW), {}, opts, NOW, (r) => entryStatus(r, entered));

    it('shows entered and open rows and counts what is left to mark', () => {
      const v = view([{ ticket: 'Jira:P-1', day: '2026-11-04', minutes: 60, at: 't' }]);
      assert.deepEqual(v.days[0].rows.map((r) => r.entry?.kind), ['entered', 'open']);
      assert.equal(v.openCount, 1);
      const html = renderTimeReport(v, state, 'n', 'csp');
      assert.match(html, /<th>Entered<\/th>/);
      assert.match(html, /✓ entered/);
      assert.match(html, /not yet/);
      assert.match(html, /id="enter"[^>]*>Mark as entered… \(1\)</);
    });

    it('disables the button when everything is entered', () => {
      const v = view([
        { ticket: 'Jira:P-1', day: '2026-11-04', minutes: 60, at: 't' },
        { ticket: 'Jira:P-2', day: '2026-11-04', minutes: 30, at: 't' },
      ]);
      assert.match(renderTimeReport(v, state, 'n', 'csp'), /id="enter"[^>]*disabled/);
    });

    it('accepts markEntered and no longer accepts logWork', () => {
      assert.deepEqual(parseReportMessage({ command: 'markEntered' }), { command: 'markEntered' });
      assert.equal(parseReportMessage({ command: 'logWork' }), undefined);
    });
  });

  describe('ticket hub status', () => {
    const input = (workStatus?: WorkStatus): HubInput => ({
      ticket: { key: 'Jira:P-1', source: 'Jira', id: 'P-1', title: 'T', status: 'In Progress', listed: true, workStatus },
      sessions: [],
      statuses: {},
      changes: {},
      events: [],
      week: [],
      now: new Date(2026, 10, 4, 15),
      opts: { idleMs: 5 * MIN, booked: 'elapsed', roundToMinutes: 15 },
    });

    it('shows the workbench status as a choice and the tracker status as read-only text', () => {
      const html = renderTicketHub(buildTicketHub(input('doing')), 'n', 'c');
      assert.match(html, /<select id="workStatus"/);
      assert.match(html, /<option value="doing" selected>Doing<\/option>/);
      assert.match(html, /Jira: In Progress/);
    });

    it('defaults to To do', () => {
      assert.match(renderTicketHub(buildTicketHub(input()), 'n', 'c'), /<option value="todo" selected>/);
    });

    it('accepts setStatus with a known status only', () => {
      assert.deepEqual(parseHubMessage({ command: 'setStatus', status: 'review' }), { command: 'setStatus', status: 'review' });
      assert.equal(parseHubMessage({ command: 'setStatus', status: 'blocked' }), undefined);
    });
  });
});
