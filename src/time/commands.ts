import * as vscode from 'vscode';
import { Session } from '../sessions/model';
import { Totals } from './compute';
import { readEvents } from './log';
import { BookedFigure, buildReport, localDays, renderCsv, renderMarkdown, ReportOptions } from './report';
import { ticketKey } from './rules';
import { idleMs } from './tracker';

export function reportOptions(): ReportOptions {
  const cfg = vscode.workspace.getConfiguration('agentWorkbench');
  return {
    idleMs: idleMs(),
    booked: cfg.get<BookedFigure>('time.bookedFigure', 'elapsed'),
    roundToMinutes: cfg.get<number>('time.roundToMinutes', 15),
  };
}

// The figure the tree shows, unrounded: the same one you book.
export function displayedMs(totals: Totals | undefined): number {
  if (!totals) {
    return 0;
  }
  const figure = reportOptions().booked;
  return figure === 'your' ? totals.yourMs : figure === 'agent' ? totals.agentMs : totals.elapsedMs;
}

function periods(now: Date): { label: string; from: Date; to: Date }[] {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const sinceMonday = (now.getDay() + 6) % 7;
  return [
    { label: 'Today', from: day(0), to: day(0) },
    { label: 'Yesterday', from: day(-1), to: day(-1) },
    { label: 'This week', from: day(-sinceMonday), to: day(0) },
    { label: 'Last week', from: day(-sinceMonday - 7), to: day(-sinceMonday - 1) },
    { label: 'This month', from: new Date(now.getFullYear(), now.getMonth(), 1), to: day(0) },
  ];
}

export async function showTimeReport(logDir: string, sessions: Session[]): Promise<void> {
  const period = await vscode.window.showQuickPick(periods(new Date()), { placeHolder: 'Report period' });
  if (!period) {
    return;
  }
  const format = await vscode.window.showQuickPick(['Open as table', 'Copy as CSV'], { placeHolder: 'Output' });
  if (!format) {
    return;
  }
  const days = localDays(period.from, period.to);
  const { events, skipped } = readEvents(logDir, { start: days[0].start, end: days[days.length - 1].end });
  const titles: Record<string, string> = {};
  for (const s of sessions) {
    titles[ticketKey(s)] = s.ticket?.title ?? s.title ?? s.id;
  }
  const opts = reportOptions();
  const rows = buildReport(events, days, titles, opts);
  if (skipped > 0) {
    void vscode.window.showWarningMessage(`Agent Workbench: ${skipped} unreadable line(s) in the time log were skipped.`);
  }
  if (format === 'Copy as CSV') {
    await vscode.env.clipboard.writeText(renderCsv(rows));
    void vscode.window.showInformationMessage(`Time report (${period.label.toLowerCase()}) copied as CSV: ${rows.length} row(s).`);
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderMarkdown(rows, opts) });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

// Asks for a correction in minutes (negative to subtract) and an optional note.
export async function promptAdjustment(session: Session): Promise<{ minutes: number; note: string } | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: `Adjust today's time for ${session.ticket ? `${session.ticket.source} ${session.ticket.id}` : session.title ?? session.id} (minutes, negative to subtract)`,
    placeHolder: '30',
    validateInput: (v) => (/^-?\d+$/.test(v.trim()) && Number(v) !== 0 && Math.abs(Number(v)) <= 1440 ? undefined : 'Enter a whole number of minutes between -1440 and 1440, not 0'),
  });
  if (value === undefined) {
    return undefined;
  }
  const note = await vscode.window.showInputBox({ prompt: 'Note (optional)', placeHolder: 'Call with the reporter' });
  if (note === undefined) {
    return undefined;
  }
  return { minutes: Number(value.trim()), note: note.trim() };
}
