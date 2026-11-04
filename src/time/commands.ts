import * as vscode from 'vscode';
import { Totals } from './compute';
import { BookedFigure, ReportOptions } from './report';
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

// Asks for a correction in minutes (negative to subtract) and an optional note.
export async function promptAdjustment(label: string): Promise<{ minutes: number; note: string } | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: `Adjust today's time for ${label} (minutes, negative to subtract)`,
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
