import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ReportRow } from '../time/report';

// One entry of the ledger: a booked day of a ticket that was sent to the tracker.
export interface LoggedEntry {
  ticket: string; // "<source>:<id>"
  day: string; // "YYYY-MM-DD"
  minutes: number;
  loggedAt: string; // ISO
}

export type LogStatus =
  | { kind: 'logged'; minutes: number }
  | { kind: 'changed'; loggedMinutes: number; minutes: number } // logged before, booked time differs now
  | { kind: 'pending'; minutes: number }
  | { kind: 'no-command' } // the ticket's source has no logCmd
  | { kind: 'no-ticket' }; // ad-hoc work

function sourceOf(ticket: string): string {
  return ticket.slice(0, ticket.indexOf(':'));
}

// What can be done with each report row. `logSources` = names of sources that have a logCmd.
export function logStatus(row: ReportRow, ledger: LoggedEntry[], logSources: Set<string>): LogStatus {
  const source = sourceOf(row.ticket);
  if (source === 'adhoc') {
    return { kind: 'no-ticket' };
  }
  if (!logSources.has(source)) {
    return { kind: 'no-command' };
  }
  const minutes = Math.round(row.bookedMs / 60_000);
  const logged = ledger.filter((e) => e.ticket === row.ticket && e.day === row.day).reduce((sum, e) => sum + e.minutes, 0);
  if (logged === 0) {
    return { kind: 'pending', minutes };
  }
  return logged === minutes ? { kind: 'logged', minutes } : { kind: 'changed', loggedMinutes: logged, minutes };
}

// Append-only, like the time log: each line one LoggedEntry; unreadable lines are skipped.
export function readLedger(file: string): LoggedEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: LoggedEntry[] = [];
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line) as LoggedEntry;
      if (typeof e.ticket === 'string' && typeof e.day === 'string' && typeof e.minutes === 'number' && typeof e.loggedAt === 'string') {
        entries.push(e);
      }
    } catch {
      // skip
    }
  }
  return entries;
}

export function appendLedger(file: string, entry: LoggedEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export interface WorklogEntry {
  ticket: string; // "<source>:<id>"
  day: string; // "YYYY-MM-DD"
  minutes: number;
  note: string;
}

// The values the log command receives, as environment variables: never pasted into the command text,
// so a note can never become part of the shell command.
export function worklogEnv(entry: WorklogEntry): Record<string, string> {
  const colon = entry.ticket.indexOf(':');
  return {
    WB_TICKET: entry.ticket,
    WB_TICKET_SOURCE: entry.ticket.slice(0, colon),
    WB_TICKET_ID: entry.ticket.slice(colon + 1),
    WB_DATE: entry.day,
    WB_MINUTES: String(entry.minutes),
    WB_SECONDS: String(entry.minutes * 60),
    WB_NOTE: entry.note,
  };
}

// Runs the source's logCmd for one entry. Resolves with stdout; rejects with stderr on failure.
export function runLogCommand(logCmd: string, entry: WorklogEntry, cwd: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(logCmd, { cwd, timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...worklogEnv(entry) } }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${entry.ticket} ${entry.day}: ${stderr.trim() || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
