import * as path from 'path';
import { AgentState } from '../agents/status';
import { Session } from '../sessions/model';
import { TimeEventType } from './events';

// The key time is booked under: one per tracker ticket, or per ad-hoc session.
export function ticketKey(session: Session): string {
  return session.ticket ? ticketKeyOf(session.ticket.source, session.ticket.id) : `adhoc:${session.id}`;
}

export function ticketKeyOf(source: string, id: string): string {
  return `${source}:${id}`;
}

// The session whose worktree contains this file, if any.
export function sessionForPath(sessions: Session[], fsPath: string, caseInsensitive: boolean): Session | undefined {
  const norm = (p: string) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
  const file = norm(fsPath);
  return sessions.find((s) => {
    const root = norm(s.worktree);
    return file === root || file.startsWith(root + path.sep);
  });
}

// Time events implied by an agent status change. A switch to "working" right after the agent
// waited on you means you just submitted a prompt or answered it: that is your activity too.
export function eventsForStatusChange(prev: AgentState | undefined, next: AgentState | undefined): TimeEventType[] {
  if (prev === next) {
    return [];
  }
  if (next === 'working') {
    return prev === 'done' || prev === 'needs-input' ? ['agent-working', 'activity'] : ['agent-working'];
  }
  return prev === 'working' ? ['agent-idle'] : [];
}
