import { TimeEvent } from '../time/events';
import { BookedFigure, buildReport, formatDuration, localDays, ReportOptions, ReportRow } from '../time/report';

export type PeriodId = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth';
export const PERIOD_IDS: PeriodId[] = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth'];
export const ROUNDING_CHOICES = [0, 15, 30, 60];

const PERIOD_LABELS: Record<PeriodId, string> = { today: 'Today', yesterday: 'Yesterday', thisWeek: 'This week', lastWeek: 'Last week', thisMonth: 'This month' };
const BOOKED_LABELS: Record<BookedFigure, string> = { elapsed: 'Elapsed (you or agents)', your: 'Your time only', agent: 'Agent time only' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface Period {
  id: PeriodId;
  label: string;
  from: Date; // local day, inclusive
  to: Date; // local day, inclusive
}

// Local calendar periods; weeks run Monday to Sunday.
export function reportPeriod(id: PeriodId, now: Date): Period {
  const d = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const monday = -((now.getDay() + 6) % 7);
  const ranges: Record<PeriodId, [Date, Date]> = {
    today: [d(0), d(0)],
    yesterday: [d(-1), d(-1)],
    thisWeek: [d(monday), d(monday + 6)],
    lastWeek: [d(monday - 7), d(monday - 1)],
    thisMonth: [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 0)],
  };
  const [from, to] = ranges[id];
  return { id, label: PERIOD_LABELS[id], from, to };
}

// ISO 8601 week number (week 1 holds the year's first Thursday).
export function isoWeek(date: Date): number {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = (utc.getUTCDay() + 6) % 7; // Monday = 0
  utc.setUTCDate(utc.getUTCDate() + 3 - weekday); // the Thursday of this week decides the year
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  return 1 + Math.floor((utc.getTime() - yearStart) / 86_400_000 / 7);
}

export interface ReportViewDay {
  label: string; // "Tue, Nov 3"
  isToday: boolean;
  rows: ReportRow[];
  totals: { yourMs: number; agentMs: number; elapsedMs: number; bookedMs: number };
}

export interface ReportView {
  title: string; // "Week 45 · Nov 2 – Nov 8"
  days: ReportViewDay[]; // only days with time
  totals: { yourMs: number; agentMs: number; elapsedMs: number; bookedMs: number };
  ticketCount: number;
  eventCount: number; // events dated inside the period
}

const dayLabel = (d: Date) => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
const shortDate = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

function sum(rows: { yourMs: number; agentMs: number; elapsedMs: number; bookedMs: number }[]) {
  return rows.reduce((t, r) => ({ yourMs: t.yourMs + r.yourMs, agentMs: t.agentMs + r.agentMs, elapsedMs: t.elapsedMs + r.elapsedMs, bookedMs: t.bookedMs + r.bookedMs }), {
    yourMs: 0,
    agentMs: 0,
    elapsedMs: 0,
    bookedMs: 0,
  });
}

export function buildReportView(events: TimeEvent[], period: Period, titles: Record<string, string>, opts: ReportOptions, now: Date): ReportView {
  const days = localDays(period.from, period.to);
  const rows = buildReport(events, days, titles, opts);
  const viewDays: ReportViewDay[] = [];
  for (const day of days) {
    const dayRows = rows.filter((r) => r.day === day.label);
    if (dayRows.length > 0) {
      viewDays.push({ label: dayLabel(new Date(day.start)), isToday: now.getTime() >= day.start && now.getTime() < day.end, rows: dayRows, totals: sum(dayRows) });
    }
  }
  const start = days[0].start;
  const end = days[days.length - 1].end;
  const titleById: Record<PeriodId, string> = {
    today: `Today · ${dayLabel(period.from)}`,
    yesterday: `Yesterday · ${dayLabel(period.from)}`,
    thisWeek: `Week ${isoWeek(period.from)} · ${shortDate(period.from)} – ${shortDate(period.to)}`,
    lastWeek: `Week ${isoWeek(period.from)} · ${shortDate(period.from)} – ${shortDate(period.to)}`,
    thisMonth: `${MONTHS_LONG[period.from.getMonth()]} ${period.from.getFullYear()}`,
  };
  return {
    title: titleById[period.id],
    days: viewDays,
    totals: sum(rows),
    ticketCount: new Set(rows.map((r) => r.ticket)).size,
    eventCount: events.filter((e) => {
      const t = Date.parse(e.ts);
      return t >= start && t < end;
    }).length,
  };
}

export interface ReportState {
  period: PeriodId;
  booked: BookedFigure;
  roundToMinutes: number;
}

export type ReportMessage =
  | { command: 'setPeriod'; period: PeriodId }
  | { command: 'setBooked'; booked: BookedFigure }
  | { command: 'setRounding'; roundToMinutes: number }
  | { command: 'copyCsv' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// The report tab's HTML. Ticket titles are tracker text: escaped.
export function renderTimeReport(view: ReportView, state: ReportState, nonce: string, cspSource: string): string {
  const f = formatDuration;
  const periodButtons = PERIOD_IDS.map((id) => `<button role="radio" data-period="${id}" aria-checked="${id === state.period}">${PERIOD_LABELS[id]}</button>`).join('');
  const bookedOptions = (Object.keys(BOOKED_LABELS) as BookedFigure[]).map((b) => `<option value="${b}"${b === state.booked ? ' selected' : ''}>${BOOKED_LABELS[b]}</option>`).join('');
  const roundingOptions = ROUNDING_CHOICES.map((m) => `<option value="${m}"${m === state.roundToMinutes ? ' selected' : ''}>${m === 0 ? 'No rounding' : `${m} min`}</option>`).join('');
  const body = view.days
    .map(
      (d) =>
        `<tr class="day"><td colspan="6">${esc(d.label)}${d.isToday ? ' · today' : ''}</td></tr>` +
        d.rows
          .map(
            (r) =>
              `<tr><td class="mono">${esc(r.ticket)}</td><td>${esc(r.title)}</td><td class="num">${f(r.yourMs)}</td><td class="num">${f(r.agentMs)}</td><td class="num">${f(r.elapsedMs)}</td><td class="num booked">${f(r.bookedMs)}</td></tr>`,
          )
          .join('') +
        `<tr class="subtotal"><td></td><td class="muted">Day total</td><td class="num">${f(d.totals.yourMs)}</td><td class="num">${f(d.totals.agentMs)}</td><td class="num">${f(d.totals.elapsedMs)}</td><td class="num booked">${f(d.totals.bookedMs)}</td></tr>`,
    )
    .join('');
  const t = view.totals;
  const table =
    view.days.length === 0
      ? '<p class="muted">No time recorded in this period.</p>'
      : `<div class="table"><table>
<thead><tr><th>Ticket</th><th>Title</th><th class="num">You</th><th class="num">Agents</th><th class="num">Elapsed</th><th class="num">Booked</th></tr></thead>
<tbody>${body}</tbody>
<tfoot><tr><td>Total</td><td></td><td class="num you">${f(t.yourMs)}</td><td class="num agents">${f(t.agentMs)}</td><td class="num">${f(t.elapsedMs)}</td><td class="num booked">${f(t.bookedMs)}</td></tr></tfoot>
</table></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Time Report</title>
<style>
body{margin:0;padding:28px 32px 48px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:13px}
main{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:24px;font-weight:600}
.muted{color:var(--vscode-descriptionForeground)}.mono{font-family:var(--vscode-editor-font-family);font-size:12px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between}
header div{display:flex;flex-direction:column;gap:6px}
.controls{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-sideBar-background)}
[role=radiogroup]{display:flex;border:1px solid var(--vscode-panel-border);border-radius:2px;overflow:hidden}
button{font:inherit;min-height:28px;padding:0 12px;border:0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button[aria-checked=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button[role=radio]{border-radius:0;background:transparent;color:var(--vscode-foreground)}
label{display:flex;gap:8px;align-items:center;color:var(--vscode-descriptionForeground)}
select{font:inherit;min-height:26px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
.table{overflow-x:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}
table{width:100%;min-width:760px;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:500;font-size:12px;color:var(--vscode-descriptionForeground);padding:9px 12px;background:var(--vscode-sideBar-background)}
td{padding:8px 12px;border-top:1px solid var(--vscode-panel-border)}
.num{text-align:right}.booked{font-weight:600}
tr.day td{font-weight:600;font-size:12px;background:var(--vscode-sideBar-background)}
tr.subtotal td{font-size:12px}
tfoot td{font-weight:600;border-top:2px solid var(--vscode-panel-border)}
.you{color:var(--vscode-charts-blue)}.agents{color:var(--vscode-charts-purple)}
</style>
</head>
<body>
<main>
<header>
  <div>
    <h1>${esc(view.title)}</h1>
    <span class="muted">Booked: <strong>${f(t.bookedMs)}</strong> across ${view.ticketCount} ticket${view.ticketCount === 1 ? '' : 's'} · computed from ${view.eventCount} recorded events</span>
  </div>
  <button id="copy">Copy as CSV</button>
</header>
<div class="controls">
  <div role="radiogroup" aria-label="Period">${periodButtons}</div>
  <label>Book <select id="booked">${bookedOptions}</select></label>
  <label>Round up to <select id="rounding">${roundingOptions}</select></label>
</div>
${table}
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const b of document.querySelectorAll('[data-period]')) {
  b.addEventListener('click', () => vscode.postMessage({ command: 'setPeriod', period: b.dataset.period }));
}
document.getElementById('booked').addEventListener('change', (e) => vscode.postMessage({ command: 'setBooked', booked: e.target.value }));
document.getElementById('rounding').addEventListener('change', (e) => vscode.postMessage({ command: 'setRounding', roundToMinutes: e.target.value }));
document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ command: 'copyCsv' }));
</script>
</body>
</html>`;
}

export function parseReportMessage(msg: unknown): ReportMessage | undefined {
  if (msg === null || typeof msg !== 'object') {
    return undefined;
  }
  const m = msg as Record<string, unknown>;
  switch (m.command) {
    case 'setPeriod':
      return PERIOD_IDS.includes(m.period as PeriodId) ? { command: 'setPeriod', period: m.period as PeriodId } : undefined;
    case 'setBooked':
      return m.booked === 'elapsed' || m.booked === 'your' || m.booked === 'agent' ? { command: 'setBooked', booked: m.booked } : undefined;
    case 'setRounding': {
      const n = Number(m.roundToMinutes);
      return ROUNDING_CHOICES.includes(n) ? { command: 'setRounding', roundToMinutes: n } : undefined;
    }
    case 'copyCsv':
      return { command: 'copyCsv' };
    default:
      return undefined;
  }
}
