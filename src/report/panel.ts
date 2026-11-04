import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { reportOptions } from '../time/commands';
import { readEvents } from '../time/log';
import { buildReport, localDays, renderCsv } from '../time/report';
import { buildReportView, parseReportMessage, renderTimeReport, reportPeriod, ReportState } from './view';

// The single "Time Report" tab. Period, booked figure and rounding are choices of this tab only;
// they start from the settings and never change them.
export class TimeReportPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state?: ReportState;
  private lastHtmlModel?: string;
  private pending?: NodeJS.Timeout;
  private warnedSkipped = false;

  constructor(
    private readonly logDir: string,
    private readonly titles: () => Record<string, string>,
  ) {}

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
    const { events, skipped } = readEvents(this.logDir, { start: days[0].start, end: days[days.length - 1].end });
    if (skipped > 0 && !this.warnedSkipped) {
      this.warnedSkipped = true;
      void vscode.window.showWarningMessage(`Agent Workbench: ${skipped} unreadable line(s) in the time log were skipped.`);
    }
    const opts = { ...reportOptions(), booked: state.booked, roundToMinutes: state.roundToMinutes };
    return { now, period, days, events, opts };
  }

  private render(): void {
    if (!this.panel || !this.state) {
      return;
    }
    const { now, period, events, opts } = this.data();
    const view = buildReportView(events, period, this.titles(), opts, now);
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
    const rows = buildReport(events, days, this.titles(), opts);
    await vscode.env.clipboard.writeText(renderCsv(rows));
    void vscode.window.showInformationMessage(`Time report (${period.label.toLowerCase()}) copied as CSV: ${rows.length} row(s).`);
  }
}
