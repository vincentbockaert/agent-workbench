// Decides when to ask "are you still working?", and when the configured end-of-day time was reached.
// Pure, so both are tested without VS Code.

export interface IdleInput {
  now: number;
  lastActivity: number; // last time you did anything in VS Code (or submitted a prompt)
  thresholdMs: number; // 0 turns the question off
  clockActive: boolean; // a ticket is accruing time
  agentWorking: boolean; // an agent is working on that ticket: you are legitimately waiting
  promptOpen: boolean; // a question is already on screen
  lastAskedAt: number | undefined;
}

export function shouldAskIdle(i: IdleInput): boolean {
  if (i.thresholdMs <= 0 || !i.clockActive || i.agentWorking || i.promptOpen) {
    return false;
  }
  if (i.now - i.lastActivity < i.thresholdMs) {
    return false;
  }
  // After an unanswered question, wait another threshold, unless you were active since then (a new idle period).
  return i.lastAskedAt === undefined || i.lastAskedAt < i.lastActivity || i.now - i.lastAskedAt >= i.thresholdMs;
}

const MAX_DAYS = 31;

// The most recent local "HH:MM" that lies in (prev, now], or undefined. Several days can pass between two
// checks (a sleeping laptop), so every day in between is considered. An invalid or empty value means disabled.
export function autoStopTime(prev: number, now: number, hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) {
    return undefined;
  }
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) {
    return undefined;
  }
  const from = new Date(Math.max(prev, now - MAX_DAYS * 24 * 3600 * 1000));
  from.setHours(0, 0, 0, 0);
  let found: number | undefined;
  for (const d = new Date(from); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes).getTime();
    if (ts > prev && ts <= now) {
      found = ts;
    }
  }
  return found;
}
