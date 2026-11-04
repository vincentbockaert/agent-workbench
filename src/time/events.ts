// One line of the append-only time log. Totals are always recomputed from these; nothing else is stored.
export type TimeEventType =
  | 'session-start'
  | 'session-end'
  | 'agent-working'
  | 'agent-idle'
  | 'focus-start' // you started attending to the session (its terminal, diff or file is active)
  | 'activity' // you did something in the session (typing, selecting, scrolling); a heartbeat
  | 'focus-end'
  | 'adjust'; // manual correction of "your time", in minutes (may be negative)

export interface TimeEvent {
  ts: string; // ISO timestamp
  ticket: string; // "<source>:<id>" or "adhoc:<sessionId>"
  session: string;
  type: TimeEventType;
  minutes?: number; // adjust only
  note?: string; // adjust only
}
