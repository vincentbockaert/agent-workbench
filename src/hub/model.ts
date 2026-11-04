import { AgentStatus, describeSince } from '../agents/status';
import { LineStats } from '../git/diff';
import { Session } from '../sessions/model';
import { ticketIntervals, totalsByTicket } from '../time/compute';
import { TimeEvent } from '../time/events';
import { buildReport, localDays, ReportDay, ReportOptions } from '../time/report';

export interface HubTicket {
  key: string; // "<source>:<id>"
  source: string;
  id: string;
  title: string;
  status?: string;
  url?: string;
  description?: string;
  listed: boolean; // still in the tracker's list (a new session can be started from it)
}

export interface HubSession {
  id: string;
  agent?: string;
  branch: string;
  state?: AgentStatus['state'];
  since?: string; // "4m"
  message?: string;
  files: number;
  added: number;
  removed: number;
}

export interface HubDay {
  label: string; // "Mon"
  elapsedMs: number;
  isToday: boolean;
}

export interface HubModel {
  ticket: HubTicket;
  sessions: HubSession[];
  week: { yourMs: number; agentMs: number; elapsedMs: number; bookedMs: number };
  days: HubDay[];
  timeline: { you: [number, number][]; agents: [number, number][]; hours: { label: string; at: number }[] }; // fractions 0..1
}

export interface HubInput {
  ticket: HubTicket;
  sessions: Session[];
  statuses: Record<string, AgentStatus | undefined>;
  // Per session, from git: changed files (binary included) and summed line counts. Missing = no data.
  changes: Record<string, ({ files: number } & LineStats) | undefined>;
  events: TimeEvent[];
  week: ReportDay[]; // Mon..Sun, local
  now: Date;
  opts: ReportOptions;
}

// Pure: everything the ticket hub shows, computed from stored data only.
export function buildTicketHub(input: HubInput): HubModel {
  const { ticket, events, opts, now } = input;

  const sessions: HubSession[] = input.sessions.map((s) => {
    const status = input.statuses[s.id];
    const changes = input.changes[s.id];
    return {
      id: s.id,
      agent: s.agent,
      branch: s.branch,
      state: status?.state,
      since: status && describeSince(status, now),
      message: status?.message,
      files: changes?.files ?? 0,
      added: changes?.added ?? 0,
      removed: changes?.removed ?? 0,
    };
  });

  const week = { yourMs: 0, agentMs: 0, elapsedMs: 0, bookedMs: 0 };
  const days: HubDay[] = input.week.map((day) => {
    const t = totalsByTicket(events, day, opts)[ticket.key];
    // Booked per day, then summed: the same numbers the time report shows.
    for (const row of buildReport(events, [day], {}, opts).filter((r) => r.ticket === ticket.key)) {
      week.bookedMs += row.bookedMs;
    }
    week.yourMs += t?.yourMs ?? 0;
    week.agentMs += t?.agentMs ?? 0;
    week.elapsedMs += t?.elapsedMs ?? 0;
    return { label: WEEKDAYS[new Date(day.start).getDay()], elapsedMs: t?.elapsedMs ?? 0, isToday: now.getTime() >= day.start && now.getTime() < day.end };
  });

  return { ticket, sessions, week, days, timeline: timeline(input) };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR = 3_600_000;

// Today's intervals as fractions of a window that covers at least 08:00–18:00, widened to whole hours
// when work happened outside it. Hour labels every two hours from the window start.
function timeline(input: HubInput): HubModel['timeline'] {
  const [today] = localDays(input.now, input.now);
  const ivs = ticketIntervals(input.events, today, input.opts)[input.ticket.key] ?? { you: [], agents: [] };
  const all = [...ivs.you, ...ivs.agents];
  const startOfDay = new Date(today.start);
  const at = (h: number) => new Date(startOfDay.getFullYear(), startOfDay.getMonth(), startOfDay.getDate(), h).getTime();
  const first = Math.min(at(8), ...all.map(([a]) => a));
  const last = Math.max(at(18), ...all.map(([, b]) => b));
  const start = at(new Date(first).getHours());
  const end = Math.min(today.end, last === at(18) ? last : at(new Date(last).getHours() + (last % HOUR === 0 ? 0 : 1)));
  const frac = (t: number) => (t - start) / (end - start);
  const hours: { label: string; at: number }[] = [];
  for (let t = start; t <= end; t += 2 * HOUR) {
    hours.push({ label: `${String(new Date(t).getHours()).padStart(2, '0')}:00`, at: frac(t) });
  }
  return {
    you: ivs.you.map(([a, b]) => [frac(a), frac(b)]),
    agents: ivs.agents.map(([a, b]) => [frac(a), frac(b)]),
    hours,
  };
}
