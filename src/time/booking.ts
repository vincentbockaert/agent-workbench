import * as fs from 'fs';
import * as path from 'path';
import { ReportRow } from './report';

// Records booked time in an append-only local ledger (either entered manually or pushed via a source's logTimeCmd).
export interface EnteredEntry {
  ticket: string; // "<source>:<id>" or "adhoc:<session>"
  day: string; // "YYYY-MM-DD"
  minutes: number; // negative for undo entries
  at: string; // ISO, when you marked or booked it
  via?: 'local' | 'tracker';
  comment?: string;
}

export type EntryStatus =
  | { kind: 'entered'; minutes: number; via?: 'local' | 'tracker' }
  | { kind: 'changed'; enteredMinutes: number; minutes: number } // more (or less) booked since you entered it
  | { kind: 'open'; minutes: number };

export function enteredMinutesOf(ticket: string, day: string, entered: EnteredEntry[]): { total: number; lastVia?: 'local' | 'tracker' } {
  let total = 0;
  let lastVia: 'local' | 'tracker' | undefined;
  for (const e of entered) {
    if (e.ticket === ticket && e.day === day) {
      total += e.minutes;
      if (e.minutes > 0) {
        lastVia = e.via ?? 'local';
      }
    }
  }
  return { total, lastVia };
}

export function entryStatus(row: ReportRow, entered: EnteredEntry[]): EntryStatus {
  const minutes = Math.round(row.bookedMs / 60_000);
  const { total: done, lastVia } = enteredMinutesOf(row.ticket, row.day, entered);
  if (done <= 0) {
    return { kind: 'open', minutes };
  }
  return done === minutes ? { kind: 'entered', minutes, ...(lastVia ? { via: lastVia } : {}) } : { kind: 'changed', enteredMinutes: done, minutes };
}

// Appends a compensating negative-minute entry so the ledger stays append-only and undoable.
export function undoEntered(file: string, ticket: string, day: string, entered: EnteredEntry[], at = new Date().toISOString()): number {
  const { total } = enteredMinutesOf(ticket, day, entered);
  if (total <= 0) {
    return 0;
  }
  appendEntered(file, { ticket, day, minutes: -total, at, via: 'local' });
  return total;
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
