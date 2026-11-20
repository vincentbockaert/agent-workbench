import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { appendEntered, EntryStatus, entryStatus, isOpen, minutesToEnter, readEntered, undoEntered } from '../time/booking';
import { reportOptions } from '../time/commands';
import { readEvents } from '../time/log';
import { buildReport, formatDuration, localDays, renderCsv, ReportRow } from '../time/report';
import { buildReportView, parseReportMessage, renderTimeReport, renderTimeReportBody, reportPeriod, ReportState } from './view';

export interface ReportDeps {
  logDir: string;
  enteredFile: string; // local record of what you entered or booked in your tracker
  titles: () => Record<string, string>;
  canBook?: (ticket: string) => boolean;
  bookToTracker?: (ticket: string, day: string, minutes: number, comment?: string) => Promise<void>;
}

// The single "Time Report" tab. Period, booked figure and rounding are choices of this tab only;
// they start from the settings and never change them.
export class TimeReportPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state?: ReportState;
  private lastHtmlModel?: string;
  private initialized = false;
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
    this.initialized = false;
    this.panel = vscode.window.createWebviewPanel('agentWorkbench.timeReport', 'Time Report', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastHtmlModel = undefined;
      this.initialized = false;
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
        case 'bookToTracker':
          void this.bookBatchToTracker();
          return;
        case 'enterRow':
          void this.enterSingleRow(msg.ticket, msg.day);
          return;
        case 'bookRow':
          void this.bookSingleRow(msg.ticket, msg.day);
          return;
        case 'undoRow':
          void this.undoSingleRow(msg.ticket, msg.day);
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
    return { now, period, days, events, opts, entered, entryState };
  }

  private render(): void {
    if (!this.panel || !this.state) {
      return;
    }
    const { now, period, events, opts, entryState } = this.data();
    const view = buildReportView(events, period, this.deps.titles(), opts, now, entryState, this.deps.canBook);
    // Skip identical redraws so the page does not jump while you read it.
    const model = JSON.stringify({ view, state: this.state });
    if (model === this.lastHtmlModel) {
      return;
    }
    this.lastHtmlModel = model;
    if (!this.initialized) {
      this.initialized = true;
      this.panel.webview.html = renderTimeReport(view, this.state, randomBytes(16).toString('hex'), this.panel.webview.cspSource);
    } else {
      void this.panel.webview.postMessage({ type: 'update', html: renderTimeReportBody(view, this.state) });
    }
  }

  private async copyCsv(): Promise<void> {
    const { days, events, opts, period } = this.data();
    const rows = buildReport(events, days, this.deps.titles(), opts);
    await vscode.env.clipboard.writeText(renderCsv(rows));
    void vscode.window.showInformationMessage(`Time report (${period.label.toLowerCase()}) copied as CSV: ${rows.length} row(s).`);
  }

  private findRow(ticket: string, day: string): { row: ReportRow; status: EntryStatus } | undefined {
    const { days, events, opts, entryState } = this.data();
    const row = buildReport(events, days, this.deps.titles(), opts).find((r) => r.ticket === ticket && r.day === day);
    return row ? { row, status: entryState(row) } : undefined;
  }

  private async enterSingleRow(ticket: string, day: string): Promise<void> {
    const found = this.findRow(ticket, day);
    if (!found || !isOpen(found.status)) {
      return;
    }
    const minutes = minutesToEnter(found.status);
    appendEntered(this.deps.enteredFile, { ticket, day, minutes, at: new Date().toISOString(), via: 'local' });
    this.lastHtmlModel = undefined;
    this.render();
  }

  private async undoSingleRow(ticket: string, day: string): Promise<void> {
    const { entered } = this.data();
    const removed = undoEntered(this.deps.enteredFile, ticket, day, entered);
    if (removed > 0) {
      this.lastHtmlModel = undefined;
      this.render();
      void vscode.window.showInformationMessage(`Cleared ${formatDuration(removed * 60_000)} local entry marker on ${ticket} (${day}).`);
    }
  }

  private async bookSingleRow(ticket: string, day: string): Promise<void> {
    if (!this.deps.bookToTracker) {
      return;
    }
    const found = this.findRow(ticket, day);
    if (!found || !isOpen(found.status)) {
      return;
    }
    const minutes = minutesToEnter(found.status);
    const comment = await vscode.window.showInputBox({
      title: `Book ${formatDuration(minutes * 60_000)} on ${ticket} (${day})`,
      prompt: 'Optional worklog comment (leave empty for none; Esc to cancel)',
      placeHolder: found.row.title,
    });
    if (comment === undefined) {
      return;
    }
    try {
      await this.deps.bookToTracker(ticket, day, minutes, comment.trim() || undefined);
      appendEntered(this.deps.enteredFile, {
        ticket,
        day,
        minutes,
        at: new Date().toISOString(),
        via: 'tracker',
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      this.lastHtmlModel = undefined;
      this.render();
      void vscode.window.showInformationMessage(`Booked ${formatDuration(minutes * 60_000)} on ${ticket} (${day}).`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Workbench: could not book time on ${ticket}: ${(e as Error).message}`);
    }
  }

  private async bookBatchToTracker(): Promise<void> {
    if (!this.deps.bookToTracker || !this.deps.canBook) {
      return;
    }
    const { days, events, opts, entryState } = this.data();
    const open = buildReport(events, days, this.deps.titles(), opts)
      .filter((row) => this.deps.canBook!(row.ticket))
      .map((row) => ({ row, status: entryState(row) }))
      .filter(({ status }) => isOpen(status));
    if (open.length === 0) {
      void vscode.window.showInformationMessage('Agent Workbench: no open bookable entries in this period.');
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
      { canPickMany: true, title: 'Book time directly to tracker', placeHolder: 'Select entries to send via your configured logTimeCmd' },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    const comment = await vscode.window.showInputBox({
      title: `Worklog comment for ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'}`,
      prompt: 'Optional comment sent via WB_COMMENT (leave empty for none; Esc to cancel)',
    });
    if (comment === undefined) {
      return;
    }
    let ok = 0;
    const errors: string[] = [];
    for (const p of picked) {
      try {
        await this.deps.bookToTracker(p.row.ticket, p.row.day, p.minutes, comment.trim() || undefined);
        appendEntered(this.deps.enteredFile, {
          ticket: p.row.ticket,
          day: p.row.day,
          minutes: p.minutes,
          at: new Date().toISOString(),
          via: 'tracker',
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        });
        ok++;
      } catch (e) {
        errors.push(`${p.row.ticket}: ${(e as Error).message}`);
      }
    }
    this.lastHtmlModel = undefined;
    this.render();
    if (ok > 0) {
      void vscode.window.showInformationMessage(`Booked ${ok} entr${ok === 1 ? 'y' : 'ies'} to tracker.`);
    }
    if (errors.length > 0) {
      void vscode.window.showErrorMessage(`Agent Workbench: ${errors.length} booking(s) failed — ${errors[0]}`);
    }
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
      appendEntered(this.deps.enteredFile, { ticket: p.row.ticket, day: p.row.day, minutes: p.minutes, at, via: 'local' });
    }
    this.lastHtmlModel = undefined;
    this.render();
    void vscode.window.showInformationMessage(`Marked ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} as entered.`);
  }
}
