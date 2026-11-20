import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bookTimeToTracker,
  buildLogTimeCommand,
  buildSetStatusCommand,
  formatTrackerDuration,
  syncStatusToTracker,
} from '../../src/tickets/trackerSync';
import { TicketSourceConfig } from '../../src/tickets/source';
import { appendEntered, entryStatus, readEntered, undoEntered } from '../../src/time/booking';
import { parseNewSessionMessage, renderNewSessionHtml } from '../../src/ui/newSessionView';

describe('trackerSync', () => {
  const baseCfg: TicketSourceConfig = {
    name: 'Jira (twg)',
    listCmd: 'echo []',
    scope: 'workspace',
    logTimeCmd: 'book --id ${id} --min ${minutes} --sec ${seconds} --dur "${duration}" --day ${day} --at ${startedAt}',
    setStatusCmd: 'twg jira workitem update --id ${id} --status "${status}"',
    statusMap: { todo: 'To Do', doing: 'In Progress', review: 'In Review', done: 'Done' },
    map: { id: 'key', title: 'summary' },
  };

  it('formats tracker durations cleanly', () => {
    assert.equal(formatTrackerDuration(0), '0m');
    assert.equal(formatTrackerDuration(45), '45m');
    assert.equal(formatTrackerDuration(60), '1h');
    assert.equal(formatTrackerDuration(90), '1h 30m');
  });

  it('builds logTimeCmd with placeholders and WB_* env vars', () => {
    const { cmd, env } = buildLogTimeCommand(baseCfg, { ticketId: 'PROJ-123', day: '2026-11-20', minutes: 90, comment: 'Fixed CI' });
    assert.equal(cmd, 'book --id PROJ-123 --min 90 --sec 5400 --dur "1h 30m" --day 2026-11-20 --at 2026-11-20T09:00:00.000+0000');
    assert.equal(env.WB_TICKET_ID, 'PROJ-123');
    assert.equal(env.WB_MINUTES, '90');
    assert.equal(env.WB_SECONDS, '5400');
    assert.equal(env.WB_DURATION, '1h 30m');
    assert.equal(env.WB_COMMENT, 'Fixed CI');
  });

  it('rejects unknown placeholders in logTimeCmd', () => {
    assert.throws(
      () => buildLogTimeCommand({ ...baseCfg, logTimeCmd: 'book ${comment}' }, { ticketId: 'P-1', day: '2026-11-20', minutes: 15 }),
      /unknown placeholder \$\{comment\}/,
    );
  });

  it('builds setStatusCmd from statusMap and skips unmapped statuses', () => {
    const built = buildSetStatusCommand(baseCfg, { ticketId: 'PROJ-123', workStatus: 'doing' });
    assert.equal(built?.trackerStatus, 'In Progress');
    assert.equal(built?.cmd, 'twg jira workitem update --id PROJ-123 --status "In Progress"');
    assert.equal(built?.env.WB_WORK_STATUS, 'doing');
    assert.equal(buildSetStatusCommand({ ...baseCfg, statusMap: { done: 'Done' } }, { ticketId: 'PROJ-123', workStatus: 'doing' }), undefined);
  });

  it('executes logTimeCmd and setStatusCmd with WB_* env vars and reports non-zero exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-'));
    try {
      const script = path.join(dir, 'echo-env.js');
      fs.writeFileSync(script, 'console.log(JSON.stringify({ id: process.env.WB_TICKET_ID, min: process.env.WB_MINUTES, comment: process.env.WB_COMMENT, status: process.env.WB_STATUS }));');
      const node = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
      const cfg: TicketSourceConfig = { ...baseCfg, logTimeCmd: node, setStatusCmd: node };

      const out = await bookTimeToTracker(cfg, dir, { ticketId: 'PROJ-9', day: '2026-11-20', minutes: 30, comment: 'Deploy fix' });
      assert.deepEqual(JSON.parse(out), { id: 'PROJ-9', min: '30', comment: 'Deploy fix' });

      const synced = await syncStatusToTracker(cfg, dir, { ticketId: 'PROJ-9', workStatus: 'done' });
      assert.equal(synced?.trackerStatus, 'Done');
      assert.deepEqual(JSON.parse(synced!.stdout), { id: 'PROJ-9', status: 'Done' });

      const failCfg: TicketSourceConfig = { ...baseCfg, logTimeCmd: `"${process.execPath.replace(/\\/g, '/')}" -e "process.stderr.write('denied'); process.exit(1)"` };
      await assert.rejects(() => bookTimeToTracker(failCfg, dir, { ticketId: 'PROJ-9', day: '2026-11-20', minutes: 15 }), /denied/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('booking undo & tracker entries', () => {
  it('records via:tracker and supports append-only undo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-book-'));
    try {
      const file = path.join(dir, 'entered.jsonl');
      const row = { day: '2026-11-20', ticket: 'Jira:PROJ-1', title: 'Test', yourMs: 0, agentMs: 0, elapsedMs: 0, timerMs: 0, bookedMs: 30 * 60_000 };
      appendEntered(file, { ticket: row.ticket, day: row.day, minutes: 30, at: 't1', via: 'tracker' });
      const s1 = entryStatus(row, readEntered(file));
      assert.deepEqual(s1, { kind: 'entered', minutes: 30, via: 'tracker' });

      const removed = undoEntered(file, row.ticket, row.day, readEntered(file), 't2');
      assert.equal(removed, 30);
      assert.deepEqual(entryStatus(row, readEntered(file)), { kind: 'open', minutes: 30 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('newSession webview', () => {
  it('escapes untrusted text and parses valid messages', () => {
    const html = renderNewSessionHtml(
      {
        heading: '<script>x</script>',
        isAdhoc: false,
        repos: [{ root: '/r', name: 'repo' }],
        selectedRepo: '/r',
        branches: [{ ref: 'main', label: 'main' }],
        selectedBranch: 'main',
        agents: [{ id: 'antigravity', label: 'Antigravity', detail: 'agy' }],
        selectedAgent: 'antigravity',
        predictedBranch: 'wb/jira-1-1',
        descriptionPlaceholder: 'Instructions',
      },
      'n1',
      'csp',
    );
    assert.ok(!html.includes('<script>x</script>'));
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.deepEqual(
      parseNewSessionMessage({ command: 'start', repoRoot: '/r', baseRef: 'main', agentId: 'antigravity', instructions: 'Do it' }),
      { command: 'start', repoRoot: '/r', baseRef: 'main', agentId: 'antigravity', instructions: 'Do it' },
    );
    assert.equal(parseNewSessionMessage({ command: 'bogus' }), undefined);
  });
});
