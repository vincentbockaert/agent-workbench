import { Session } from '../sessions/model';
import { AgentOptions, AgentProfile } from './profiles';

export interface AgentChoice {
  profile?: AgentProfile; // undefined = no agent, just the worktree
  label: string;
  description?: string; // "default", "last used on this ticket"
}

// Quick-pick order for "Work on this": the preferred choice first, so Enter accepts it.
export function agentChoices(profiles: AgentProfile[], defaultId: string, lastUsedId: string | undefined, preferNone: boolean): AgentChoice[] {
  const def = profiles.find((p) => p.id === defaultId);
  const last = profiles.find((p) => p.id === lastUsedId);
  const ordered = [def, last !== def ? last : undefined, ...profiles].filter((p, i, all): p is AgentProfile => p !== undefined && all.indexOf(p) === i);
  const choices: AgentChoice[] = ordered.map((p) => ({
    profile: p,
    label: p.label,
    description: p === def ? 'default' : p === last ? 'last used on this ticket' : undefined,
  }));
  const none: AgentChoice = { label: 'No agent — just the worktree' };
  return preferNone ? [none, ...choices] : [...choices, none];
}

// The model and effort of the newest session of this ticket that ran this agent; {} for ad-hoc work or none yet.
export function lastOptions(sessions: Session[], ticket: { source: string; id: string } | undefined, agentId: string): AgentOptions {
  if (!ticket) {
    return {};
  }
  const last = sessions.filter((s) => s.ticket?.source === ticket.source && s.ticket.id === ticket.id && s.agent === agentId).pop();
  return last ? { ...(last.model ? { model: last.model } : {}), ...(last.effort ? { effort: last.effort } : {}) } : {};
}
