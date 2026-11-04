import * as fs from 'fs';
import * as path from 'path';
import { ReportRow } from './report';

// You enter booked time in your tracker or timesheet yourself; this records locally that you did.
// Nothing here talks to a tracker.
export interface EnteredEntry {
  ticket: string; // "<source>:<id>" or "adhoc:<session>"
  day: string; // "YYYY-MM-DD"
  minutes: number;
  at: string; // ISO, when you marked it
}

export type EntryStatus =
  | { kind: 'entered'; minutes: number }
  | { kind: 'changed'; enteredMinutes: number; minutes: number } // more (or less) booked since you entered it
  | { kind: 'open'; minutes: number };

export function entryStatus(row: ReportRow, entered: EnteredEntry[]): EntryStatus {
  const minutes = Math.round(row.bookedMs / 60_000);
  const done = entered.filter((e) => e.ticket === row.ticket && e.day === row.day).reduce((sum, e) => sum + e.minutes, 0);
  if (done === 0) {
    return { kind: 'open', minutes };
  }
  return done === minutes ? { kind: 'entered', minutes } : { kind: 'changed', enteredMinutes: done, minutes };
}

// Rows "Mark as entered…" offers: not entered yet, or booked time grew since.
export function isOpen(status: EntryStatus | undefined): boolean {
  return status?.kind === 'open' || (status?.kind === 'changed' && status.minutes > status.enteredMinutes);
}

// Minutes still to enter for a row: all of it, or the growth since it was last entered.
export function minutesToEnter(status: EntryStatus): number {
  return status.kind === 'changed' ? status.minutes - status.enteredMinutes : status.minutes;
}

// Append-only, like the time log; unreadable lines are skipped.
export function readEntered(file: string): EnteredEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: EnteredEntry[] = [];
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line) as EnteredEntry;
      if (typeof e.ticket === 'string' && typeof e.day === 'string' && typeof e.minutes === 'number' && typeof e.at === 'string') {
        entries.push(e);
      }
    } catch {
      // skip
    }
  }
  return entries;
}

export function appendEntered(file: string, entry: EnteredEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
