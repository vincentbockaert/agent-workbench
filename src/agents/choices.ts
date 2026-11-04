import { AgentProfile } from './profiles';

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
