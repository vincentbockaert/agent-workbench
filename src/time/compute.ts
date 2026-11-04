import { TimeEvent } from './events';

export interface Range {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
}

export interface Totals {
  yourMs: number;
  agentMs: number;
  elapsedMs: number;
}

export interface ComputeOptions {
  idleMs: number;
}

type Interval = [number, number];

interface SessionState {
  ticket: string;
  last: number; // time of this session's last recorded event; open intervals close here
  agentStart?: number;
  focus?: { start: number; last: number };
}

// Per-ticket totals within a range (e.g. one local day). Pure: same events in, same numbers out.
//
// Agent time: agent-working until agent-idle / session-end.
// Your time: from focus-start, extended by heartbeats (activity) while gaps stay within idleMs;
// a longer gap ends the interval at the last heartbeat. focus-end closes it.
// Intervals left open (crash, missing end) close at the session's last recorded event, never "now".
// Parallel sessions of one ticket are unioned, so nothing is counted twice.
export function totalsByTicket(events: TimeEvent[], range: Range, opts: ComputeOptions): Record<string, Totals> {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const agent = new Map<string, Interval[]>();
  const focus = new Map<string, Interval[]>();
  const adjustMs = new Map<string, number>();
  const sessions = new Map<string, SessionState>();
  const push = (map: Map<string, Interval[]>, ticket: string, iv: Interval) => map.set(ticket, [...(map.get(ticket) ?? []), iv]);

  const closeAgent = (s: SessionState, at: number) => {
    if (s.agentStart !== undefined) {
      push(agent, s.ticket, [s.agentStart, at]);
      s.agentStart = undefined;
    }
  };
  const closeFocus = (s: SessionState, at: number) => {
    if (s.focus) {
      push(focus, s.ticket, [s.focus.start, at - s.focus.last <= opts.idleMs ? at : s.focus.last]);
      s.focus = undefined;
    }
  };
  const heartbeat = (s: SessionState, at: number) => {
    if (!s.focus) {
      return;
    }
    if (at - s.focus.last > opts.idleMs) {
      push(focus, s.ticket, [s.focus.start, s.focus.last]);
      s.focus.start = at;
    }
    s.focus.last = at;
  };

  for (const e of sorted) {
    const t = Date.parse(e.ts);
    const s = sessions.get(e.session) ?? { ticket: e.ticket, last: t };
    sessions.set(e.session, s);
    switch (e.type) {
      case 'agent-working':
        s.agentStart ??= t;
        break;
      case 'agent-idle':
        closeAgent(s, t);
        break;
      case 'focus-start':
        if (s.focus) {
          heartbeat(s, t);
        } else {
          s.focus = { start: t, last: t };
        }
        break;
      case 'activity':
        heartbeat(s, t);
        break;
      case 'focus-end':
        closeFocus(s, t);
        break;
      case 'session-end':
        closeAgent(s, t);
        closeFocus(s, t);
        break;
      case 'adjust':
        if (t >= range.start && t < range.end) {
          adjustMs.set(e.ticket, (adjustMs.get(e.ticket) ?? 0) + (e.minutes ?? 0) * 60_000);
        }
        break;
      case 'session-start':
        break;
    }
    s.last = t;
  }
  for (const s of sessions.values()) {
    closeAgent(s, s.last);
    if (s.focus) {
      push(focus, s.ticket, [s.focus.start, s.focus.last]);
    }
  }

  const result: Record<string, Totals> = {};
  const tickets = new Set([...agent.keys(), ...focus.keys(), ...adjustMs.keys()]);
  for (const ticket of tickets) {
    const a = clip(agent.get(ticket) ?? [], range);
    const f = clip(focus.get(ticket) ?? [], range);
    const adjust = adjustMs.get(ticket) ?? 0;
    const totals = {
      yourMs: Math.max(0, length(union(f)) + adjust),
      agentMs: length(union(a)),
      elapsedMs: Math.max(0, length(union([...a, ...f])) + adjust),
    };
    if (totals.yourMs > 0 || totals.agentMs > 0 || totals.elapsedMs > 0) {
      result[ticket] = totals;
    }
  }
  return result;
}

function clip(intervals: Interval[], range: Range): Interval[] {
  return intervals
    .map(([a, b]): Interval => [Math.max(a, range.start), Math.min(b, range.end)])
    .filter(([a, b]) => b > a);
}

function union(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  const merged: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

function length(intervals: Interval[]): number {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
}

// Sum over tickets (what you book), not a union: two tickets worked in parallel both count.
export function sumTotals(byTicket: Record<string, Totals>): Totals {
  const sum = { yourMs: 0, agentMs: 0, elapsedMs: 0 };
  for (const t of Object.values(byTicket)) {
    sum.yourMs += t.yourMs;
    sum.agentMs += t.agentMs;
    sum.elapsedMs += t.elapsedMs;
  }
  return sum;
}

// Rounds up to whole blocks of `minutes` for booking; 0 stays 0. Only used in reports.
export function roundUpMs(ms: number, minutes: number): number {
  if (minutes <= 0) {
    return ms;
  }
  const block = minutes * 60_000;
  return Math.ceil(ms / block) * block;
}
