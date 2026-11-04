import * as fs from 'fs';
import * as path from 'path';
import { TimeEvent, TimeEventType } from './events';

const TYPES: TimeEventType[] = ['session-start', 'session-end', 'agent-working', 'agent-idle', 'focus-start', 'activity', 'focus-end', 'adjust'];

// One file per UTC month keeps files small; lines are only ever appended, never edited.
function monthFile(dir: string, ts: string): string {
  return path.join(dir, `${ts.slice(0, 7)}.jsonl`);
}

export function appendEvent(dir: string, event: TimeEvent): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(monthFile(dir, event.ts), `${JSON.stringify(event)}\n`);
}

// Intervals can start before the range (e.g. yesterday evening), so the previous month is read too.
const LOOKBACK_MS = 32 * 24 * 3600 * 1000;

// Events from all monthly files that can overlap the range, sorted by time. Unreadable lines are skipped and counted.
export function readEvents(dir: string, range: { start: number; end: number }): { events: TimeEvent[]; skipped: number } {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { events: [], skipped: 0 };
  }
  const from = new Date(range.start - LOOKBACK_MS).toISOString().slice(0, 7);
  const to = new Date(range.end).toISOString().slice(0, 7);
  const events: TimeEvent[] = [];
  let skipped = 0;
  for (const file of files.filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
    const month = file.slice(0, 7);
    if (month < from || month > to) {
      continue;
    }
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const event = parse(line);
      if (event) {
        events.push(event);
      } else {
        skipped++;
      }
    }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { events, skipped };
}

function parse(line: string): TimeEvent | undefined {
  try {
    const e = JSON.parse(line) as TimeEvent;
    const valid =
      typeof e === 'object' &&
      e !== null &&
      !Number.isNaN(Date.parse(e.ts)) &&
      typeof e.ticket === 'string' &&
      typeof e.session === 'string' &&
      TYPES.includes(e.type);
    return valid ? e : undefined;
  } catch {
    return undefined;
  }
}
