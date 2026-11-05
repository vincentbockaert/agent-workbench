// One line of the append-only time log. Totals are always recomputed from these; nothing else is stored.
export type TimeEventType =
  | 'session-start'
  | 'session-end'
  | 'agent-working'
  | 'agent-idle'
  | 'focus-start' // you started attending to the session (its terminal, diff or file is active)
  | 'activity' // you did something in the session (typing, selecting, scrolling); a heartbeat
  | 'focus-end'
  | 'adjust' // manual correction of "your time", in minutes (may be negative)
  // The work-item clock. Ticket-level: several tickets can be on the clock, exactly one is active.
  | 'clock-on' // the ticket goes on the clock and becomes the active one
  | 'clock-off' // the ticket leaves the clock; if it was active, nobody is until the next attend
  | 'attend' // your attention moved to this ticket (ignored unless it is on the clock)
  | 'clock-beat' // global: the clock was alive now; open intervals close at the last event of any kind
  | 'clock-reset'; // global: closes the active interval at the last event before it and clears the clock

export interface TimeEvent {
  ts: string; // ISO timestamp
  ticket: string; // "<source>:<id>" or "adhoc:<sessionId>"
  session: string;
  type: TimeEventType;
  minutes?: number; // adjust only
  note?: string; // adjust only
}
