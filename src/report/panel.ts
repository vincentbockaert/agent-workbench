import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { appendEntered, EntryStatus, entryStatus, isOpen, minutesToEnter, readEntered } from '../time/booking';
import { reportOptions } from '../time/commands';
import { readEvents } from '../time/log';
import { buildReport, formatDuration, localDays, renderCsv, ReportRow } from '../time/report';
import { buildReportView, parseReportMessage, renderTimeReport, reportPeriod, ReportState } from './view';

export interface ReportDeps {
  logDir: string;
  enteredFile: string; // local record of what you entered in your tracker or timesheet
  titles: () => Record<string, string>;
}

// The single "Time Report" tab. Period, booked figure and rounding are choices of this tab only;
// they start from the settings and never change them. Nothing here writes to a tracker.
export class TimeReportPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state?: ReportState;
  private lastHtmlModel?: string;
  private pending?: NodeJS.Timeout;
  private warnedSkipped = false;

  constructor(private readonly deps: ReportDeps) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const opts = reportOptions();
    this.state = { period: 'thisWeek', booked: opts.booked, roundToMinutes: opts.roundToMinutes };
    this.panel = vscode.window.createWebviewPanel('agentWorkbench.timeReport', 'Time Report', vscode.ViewColumn.Active, { enableScripts: true });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastHtmlModel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((raw) => {
      const msg = parseReportMessage(raw);
      if (!msg || !this.state) {
        return;
      }
      switch (msg.command) {
        case 'setPeriod':
          this.state.period = msg.period;
          break;
        case 'setBooked':
          this.state.booked = msg.booked;
          break;
        case 'setRounding':
          this.state.roundToMinutes = msg.roundToMinutes;
          break;
        case 'copyCsv':
          void this.copyCsv();
          return;
        case 'markEntered':
          void this.markEntered();
          return;
      }
      this.render();
    });
    this.render();
  }

  // Debounced, like the ticket hub: time events can arrive every few seconds.
  refresh(): void {
    if (!this.panel || this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.render();
    }, 1000);
  }

  dispose(): void {
    clearTimeout(this.pending);
    this.panel?.dispose();
  }

  private data() {
    const state = this.state!;
    const now = new Date();
    const period = reportPeriod(state.period, now);
    const days = localDays(period.from, period.to);
    const { events, skipped } = readEvents(this.deps.logDir, { start: days[0].start, end: days[days.length - 1].end });
    if (skipped > 0 && !this.warnedSkipped) {
      this.warnedSkipped = true;
      void vscode.window.showWarningMessage(`Agent Workbench: ${skipped} unreadable line(s) in the time log were skipped.`);
    }
    const opts = { ...reportOptions(), booked: state.booked, roundToMinutes: state.roundToMinutes };
    const entered = readEntered(this.deps.enteredFile);
    const entryState = (row: ReportRow): EntryStatus => entryStatus(row, entered);
    return { now, period, days, events, opts, entryState };
  }

  private render(): void {
    if (!this.panel || !this.state) {
      return;
    }
    const { now, period, events, opts, entryState } = this.data();
    const view = buildReportView(events, period, this.deps.titles(), opts, now, entryState);
    // Skip identical redraws so the page does not jump while you read it.
    const model = JSON.stringify({ view, state: this.state });
    if (model === this.lastHtmlModel) {
      return;
    }
    this.lastHtmlModel = model;
    this.panel.webview.html = renderTimeReport(view, this.state, randomBytes(16).toString('hex'), this.panel.webview.cspSource);
  }

  private async copyCsv(): Promise<void> {
    const { days, events, opts, period } = this.data();
    const rows = buildReport(events, days, this.deps.titles(), opts);
    await vscode.env.clipboard.writeText(renderCsv(rows));
    void vscode.window.showInformationMessage(`Time report (${period.label.toLowerCase()}) copied as CSV: ${rows.length} row(s).`);
  }

  // You enter the time in your tracker or timesheet yourself, then tick it here so the report shows what is left.
  private async markEntered(): Promise<void> {
    const { days, events, opts, entryState } = this.data();
    const open = buildReport(events, days, this.deps.titles(), opts)
      .map((row) => ({ row, status: entryState(row) }))
      .filter(({ status }) => isOpen(status));
    if (open.length === 0) {
      void vscode.window.showInformationMessage('Agent Workbench: everything in this period is marked as entered.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      open.map(({ row, status }) => ({
        label: `${row.ticket} · ${row.day}`,
        description: `${formatDuration(minutesToEnter(status) * 60_000)}${status.kind === 'changed' ? ' more' : ''}`,
        detail: row.title,
        row,
        minutes: minutesToEnter(status),
      })),
      { canPickMany: true, title: 'Mark as entered in your tracker or timesheet', placeHolder: 'Tick what you have entered; nothing is sent anywhere' },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    const at = new Date().toISOString();
    for (const p of picked) {
      appendEntered(this.deps.enteredFile, { ticket: p.row.ticket, day: p.row.day, minutes: p.minutes, at });
    }
    this.lastHtmlModel = undefined;
    this.render();
    void vscode.window.showInformationMessage(`Marked ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} as entered.`);
  }
}
