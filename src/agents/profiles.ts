// An agent is just a pair of shell commands run in the session's worktree.
export interface AgentProfile {
  id: string;
  label: string;
  startCmd: string;
  // Starts the agent with no prompt, for when the user wants to type the first request themselves.
  // Without it the bare start falls back to startCmd.
  startNoPromptCmd?: string;
  resumeCmd?: string;
}

// Commands run with the worktree as cwd, so "continue the latest conversation here" is per session.
// The prompt is passed as a relative path: no absolute paths, so no shell quoting issues.
const START_PROMPT = 'Read ${promptFile} and do the task described there. Follow its Instructions section first, if it has one.';
export const DEFAULT_PROFILES: AgentProfile[] = [
  { id: 'claude', label: 'Claude Code', startCmd: `claude -n \${sessionId} "${START_PROMPT}"`, startNoPromptCmd: 'claude -n ${sessionId}', resumeCmd: 'claude --continue' },
  { id: 'codex', label: 'Codex', startCmd: `codex "${START_PROMPT}"`, startNoPromptCmd: 'codex', resumeCmd: 'codex resume --last' },
];

export interface CommandVars {
  sessionId: string;
  branch: string;
}

const PROMPT_FILE = '.workbench/TASK.md';
const PLACEHOLDER = /\$\{(\w+)\}/g;

// User profiles replace defaults with the same id and are appended otherwise; invalid entries are skipped.
export function mergeProfiles(user: unknown[]): { profiles: AgentProfile[]; problems: string[] } {
  const profiles = [...DEFAULT_PROFILES];
  const problems: string[] = [];
  for (const entry of user) {
    const problem = validate(entry);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const p = entry as AgentProfile;
    const i = profiles.findIndex((d) => d.id === p.id);
    if (i >= 0) {
      profiles[i] = p;
    } else {
      profiles.push(p);
    }
  }
  return { profiles, problems };
}

function validate(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') {
    return `agent profile ${JSON.stringify(entry)} is not an object`;
  }
  const p = entry as Partial<AgentProfile>;
  const name = p.id ?? '(no id)';
  for (const key of ['id', 'label', 'startCmd'] as const) {
    if (typeof p[key] !== 'string' || p[key] === '') {
      return `agent profile ${name} needs a non-empty "${key}"`;
    }
  }
  if (p.resumeCmd !== undefined && typeof p.resumeCmd !== 'string') {
    return `agent profile ${name}: "resumeCmd" must be a string`;
  }
  if (p.startNoPromptCmd !== undefined && typeof p.startNoPromptCmd !== 'string') {
    return `agent profile ${name}: "startNoPromptCmd" must be a string`;
  }
  try {
    for (const cmd of [p.startCmd!, p.resumeCmd ?? '', p.startNoPromptCmd ?? '']) {
      expandCommand(cmd, { sessionId: '', branch: '' });
    }
  } catch (e) {
    return `agent profile ${name}: ${(e as Error).message}`;
  }
  return undefined;
}

// Single pass, so placeholders inside inserted values are left as they are.
export function expandCommand(template: string, vars: CommandVars): string {
  const values: Record<string, string> = { promptFile: PROMPT_FILE, sessionId: vars.sessionId, branch: vars.branch };
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!(name in values)) {
      throw new Error(`unknown placeholder ${match} (use \${promptFile}, \${sessionId} or \${branch})`);
    }
    return values[name];
  });
}

// 'start' hands the agent the TASK.md prompt, 'start-bare' opens it with no prompt, 'resume' continues the last conversation.
export type AgentMode = 'start' | 'start-bare' | 'resume';

export function agentCommand(profile: AgentProfile, mode: AgentMode, vars: CommandVars): string {
  if (mode === 'resume' && !profile.resumeCmd) {
    throw new Error(`${profile.label} has no resume command`);
  }
  const template = mode === 'resume' ? profile.resumeCmd! : mode === 'start-bare' ? profile.startNoPromptCmd ?? profile.startCmd : profile.startCmd;
  return expandCommand(template, vars);
}
