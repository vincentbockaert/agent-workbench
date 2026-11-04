import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { TicketSourceConfig } from '../tickets/source';
import { reportOptions } from '../time/commands';
import { readEvents } from '../time/log';
import { buildReport, formatDuration, localDays, renderCsv, ReportRow } from '../time/report';
import { appendLedger, LogStatus, logStatus, readLedger, runLogCommand } from '../worklog/worklog';
import { buildReportView, isLoggable, parseReportMessage, renderTimeReport, reportPeriod, ReportState } from './view';

export interface ReportDeps {
  logDir: string;
  ledgerFile: string;
  titles: () => Record<string, string>;
  sources: () => TicketSourceConfig[];
  cwd: () => string; // where log commands run (the workspace folder)
}

// The single "Time Report" tab. Period, booked figure and rounding are choices of this tab only;
// they start from the settings and never change them.
export class TimeReportPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state?: ReportState;
  private lastHtmlModel?: string;
  private pending?: NodeJS.Timeout;
  private warnedSkipped = false;
  private logging = false;

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
        case 'logWork':
          void this.logWork();
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
    const ledger = readLedger(this.deps.ledgerFile);
    const logSources = new Set(this.deps.sources().filter((s) => s.logCmd).map((s) => s.name));
    const logState = (row: ReportRow): LogStatus => logStatus(row, ledger, logSources);
    return { now, period, days, events, opts, logState };
  }

  private render(): void {
    if (!this.panel || !this.state) {
      return;
    }
    const { now, period, events, opts, logState } = this.data();
    const view = buildReportView(events, period, this.deps.titles(), opts, now, logState);
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

  // Sending worklogs changes what others see in the tracker: you pick the entries, then confirm once more.
  private async logWork(): Promise<void> {
    if (this.logging) {
      return;
    }
    const { days, events, opts, logState } = this.data();
    const titles = this.deps.titles();
    const candidates = buildReport(events, days, titles, opts)
      .map((row) => ({ row, log: logState(row) }))
      .filter(({ log }) => isLoggable(log))
      .map(({ row, log }) => {
        // For a top-up, only the time booked since the last log is sent.
        const minutes = log.kind === 'changed' ? log.minutes - log.loggedMinutes : (log as { minutes: number }).minutes;
        return { row, minutes, topUp: log.kind === 'changed' };
      });
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Agent Workbench: nothing to log in this period.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: `${c.row.ticket} · ${c.row.day}`,
        description: `${formatDuration(c.minutes * 60_000)}${c.topUp ? ' (top-up)' : ''}`,
        detail: c.row.title,
        candidate: c,
      })),
      { canPickMany: true, title: 'Log to tracker: tick the entries to send', placeHolder: 'Nothing is sent until you confirm' },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    const note = await vscode.window.showInputBox({ prompt: 'Worklog comment (optional, sent with every entry)', placeHolder: 'Implementation and review' });
    if (note === undefined) {
      return;
    }
    const total = picked.reduce((sum, p) => sum + p.candidate.minutes, 0);
    const commands = [...new Set(picked.map((p) => p.candidate.row.ticket.slice(0, p.candidate.row.ticket.indexOf(':'))))]
      .map((name) => `${name}: ${this.deps.sources().find((s) => s.name === name)?.logCmd}`)
      .join('\n');
    const ok = await vscode.window.showWarningMessage(
      `Log ${picked.length} worklog entr${picked.length === 1 ? 'y' : 'ies'} (${formatDuration(total * 60_000)}) to the tracker?`,
      { modal: true, detail: `${picked.map((p) => `${p.label}  ${p.description}`).join('\n')}\n\nRuns:\n${commands}` },
      'Log',
    );
    if (ok !== 'Log') {
      return;
    }

    this.logging = true;
    const failures: string[] = [];
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Logging work…' }, async (progress) => {
        for (const p of picked) {
          const { row, minutes } = p.candidate;
          const source = this.deps.sources().find((s) => s.name === row.ticket.slice(0, row.ticket.indexOf(':')));
          progress.report({ message: p.label });
          try {
            await runLogCommand(source!.logCmd!, { ticket: row.ticket, day: row.day, minutes, note: note.trim() }, this.deps.cwd());
            // Recorded only after the tracker accepted it, so a failure can simply be retried.
            appendLedger(this.deps.ledgerFile, { ticket: row.ticket, day: row.day, minutes, loggedAt: new Date().toISOString() });
          } catch (e) {
            failures.push((e as Error).message);
          }
        }
      });
    } finally {
      this.logging = false;
      this.lastHtmlModel = undefined;
      this.render();
    }
    const logged = picked.length - failures.length;
    if (failures.length === 0) {
      void vscode.window.showInformationMessage(`Logged ${logged} worklog entr${logged === 1 ? 'y' : 'ies'}.`);
    } else {
      void vscode.window.showErrorMessage(`Logged ${logged} of ${picked.length}. Failed:\n${failures.join('\n')}`);
    }
  }
}
