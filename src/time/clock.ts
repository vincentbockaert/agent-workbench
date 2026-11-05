import { TimeEventType } from './events';

// How long your focus must stay on another ticket before the clock follows it. A peek at another terminal
// should not steal time; once the switch counts it is backdated to when your focus moved.
export const SWITCH_DEBOUNCE_MS = 10_000;
export const BEAT_MS = 60_000;

// Everything the clock needs from the outside, so it runs under test without VS Code or real time.
export interface ClockEnv {
  now(): number;
  emit(type: TimeEventType, ticket: string, at: number): void;
  after(ms: number, fn: () => void): () => void; // returns a cancel function
}

// The work-item clock: which tickets are on it, and which one your attention is on.
// Only the active ticket accrues time (see totalsByTicket), so switching moves time instead of double counting.
export class ClockTracker {
  private readonly onClock = new Set<string>(); // insertion order = order started
  private active?: string;
  private pending?: { ticket: string; since: number; cancel: () => void };

  constructor(
    private readonly env: ClockEnv,
    private readonly onChange: () => void = () => {},
  ) {}

  state(): { onClock: string[]; active: string | undefined } {
    return { onClock: [...this.onClock], active: this.active };
  }

  // The user began work on this ticket (Work on this, Open Agent, Open Shell, Start Timer).
  start(ticket: string): void {
    this.cancelPending();
    if (this.onClock.has(ticket) && this.active === ticket) {
      return;
    }
    this.env.emit('clock-on', ticket, this.env.now());
    this.onClock.add(ticket);
    this.active = ticket;
    this.onChange();
  }

  // `at` lets the idle prompt backdate the stop to the last activity.
  stop(ticket: string, at = this.env.now()): void {
    if (!this.onClock.has(ticket)) {
      return;
    }
    this.cancelPending();
    this.env.emit('clock-off', ticket, at);
    this.onClock.delete(ticket);
    if (this.active === ticket) {
      this.active = undefined;
    }
    this.onChange();
  }

  stopAll(at = this.env.now()): void {
    if (this.onClock.size === 0) {
      return;
    }
    this.cancelPending();
    for (const ticket of this.onClock) {
      this.env.emit('clock-off', ticket, at);
    }
    this.onClock.clear();
    this.active = undefined;
    this.onChange();
  }

  // Your attention is on this ticket's work (a terminal, a file, a prompt); undefined = on something unrelated
  // or outside VS Code. Unrelated focus never stops the clock, so thinking and reading time count.
  focus(ticket: string | undefined): void {
    if (ticket === undefined || !this.onClock.has(ticket) || ticket === this.active) {
      this.cancelPending();
      return;
    }
    if (this.active === undefined) {
      this.attend(ticket, this.env.now());
      return;
    }
    if (this.pending?.ticket === ticket) {
      return; // keep the time focus first moved here
    }
    this.cancelPending();
    const since = this.env.now();
    const cancel = this.env.after(SWITCH_DEBOUNCE_MS, () => {
      if (this.pending?.ticket === ticket) {
        this.attend(ticket, since);
      }
    });
    this.pending = { ticket, since, cancel };
  }

  // Proof of life while the active ticket accrues time, so a crash loses at most one beat.
  beat(): void {
    if (this.active !== undefined) {
      this.env.emit('clock-beat', '', this.env.now());
    }
  }

  // A fresh start: whatever was open before (crash, restart) closes at the last recorded event.
  reset(): void {
    this.cancelPending();
    this.env.emit('clock-reset', '', this.env.now());
    this.onClock.clear();
    this.active = undefined;
    this.onChange();
  }

  private attend(ticket: string, at: number): void {
    this.pending = undefined;
    this.env.emit('attend', ticket, at);
    this.active = ticket;
    this.onChange();
  }

  private cancelPending(): void {
    this.pending?.cancel();
    this.pending = undefined;
  }
}
