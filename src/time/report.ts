import { ComputeOptions, roundUpMs, Totals, totalsByTicket } from './compute';
import { TimeEvent } from './events';

export type BookedFigure = 'elapsed' | 'your' | 'agent';

export interface ReportDay {
  label: string; // e.g. "2026-11-04"
  start: number;
  end: number;
}

export interface ReportRow {
  day: string;
  ticket: string;
  title: string;
  yourMs: number;
  agentMs: number;
  elapsedMs: number;
  bookedMs: number;
}

export interface ReportOptions extends ComputeOptions {
  booked: BookedFigure;
  roundToMinutes: number;
}

const MIN = 60_000;
const FIGURE: Record<BookedFigure, keyof Totals> = { elapsed: 'elapsedMs', your: 'yourMs', agent: 'agentMs' };

// Local calendar days [from, to] inclusive, each from local midnight to the next (DST-safe).
export function localDays(from: Date, to: Date): ReportDay[] {
  const days: ReportDay[] = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; ) {
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const label = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    days.push({ label, start: d.getTime(), end: next.getTime() });
    d = next;
  }
  return days;
}

export function buildReport(events: TimeEvent[], days: ReportDay[], titles: Record<string, string>, opts: ReportOptions): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const day of days) {
    const totals = totalsByTicket(events, day, opts);
    for (const ticket of Object.keys(totals).sort()) {
      const t = totals[ticket];
      rows.push({
        day: day.label,
        ticket,
        title: titles[ticket] ?? ticket,
        ...t,
        bookedMs: roundUpMs(t[FIGURE[opts.booked]], opts.roundToMinutes),
      });
    }
  }
  return rows;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MIN);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export function renderMarkdown(rows: ReportRow[], opts: ReportOptions): string {
  if (rows.length === 0) {
    return '# Time report\n\nNo time recorded in this period.\n';
  }
  const rounding = opts.roundToMinutes > 0 ? `, rounded up to ${opts.roundToMinutes}m` : '';
  const header = `| Ticket | Title | Your | Agent | Elapsed | Booked (${opts.booked}${rounding}) |\n|---|---|---|---|---|---|`;
  const out = ['# Time report', ''];
  for (const day of [...new Set(rows.map((r) => r.day))]) {
    const dayRows = rows.filter((r) => r.day === day);
    out.push(`## ${day}`, '', header);
    for (const r of dayRows) {
      out.push(`| ${r.ticket} | ${r.title.replace(/\|/g, '\\|')} | ${formatDuration(r.yourMs)} | ${formatDuration(r.agentMs)} | ${formatDuration(r.elapsedMs)} | ${formatDuration(r.bookedMs)} |`);
    }
    const sum = (k: keyof ReportRow) => dayRows.reduce((acc, r) => acc + (r[k] as number), 0);
    out.push(`| **Total** | | ${formatDuration(sum('yourMs'))} | ${formatDuration(sum('agentMs'))} | ${formatDuration(sum('elapsedMs'))} | ${formatDuration(sum('bookedMs'))} |`, '');
  }
  return out.join('\n');
}

export function renderCsv(rows: ReportRow[]): string {
  const lines = ['date,ticket,title,your_minutes,agent_minutes,elapsed_minutes,booked_minutes'];
  for (const r of rows) {
    const mins = [r.yourMs, r.agentMs, r.elapsedMs, r.bookedMs].map((ms) => Math.round(ms / MIN));
    lines.push([r.day, csvField(r.ticket), csvField(r.title), ...mins].join(','));
  }
  return lines.join('\n') + '\n';
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
