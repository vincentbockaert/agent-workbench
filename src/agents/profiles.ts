// An agent is just a pair of shell commands run in the session's worktree.
export interface AgentProfile {
  id: string;
  label: string;
  startCmd: string;
  // Starts the agent with no prompt, for when the user wants to type the first request themselves.
  // Without it the bare start falls back to startCmd.
  startNoPromptCmd?: string;
  resumeCmd?: string;
  // Used instead of resumeCmd when status.json recorded an agentSessionId (e.g. agy --conversation ${agentSessionId}).
  resumeWithIdCmd?: string;
  // How to pass a model and an effort, e.g. "--model ${value}"; they land at ${options} in the commands.
  modelArg?: string;
  effortArg?: string;
  // What the pickers offer (you can always type another model), and what they preselect for this agent.
  models?: string[];
  efforts?: string[];
  defaultModel?: string;
  defaultEffort?: string;
}

// The model and effort chosen for a session; undefined = no flag, the agent's own default.
export interface AgentOptions {
  model?: string;
  effort?: string;
}

// Commands run with the worktree as cwd, so "continue the latest conversation here" is per session.
// The prompt is passed as a relative path: no absolute paths, so no shell quoting issues.
const START_PROMPT = 'Read ${promptFile} and do the task described there. Follow its Instructions section first, if it has one.';
export const DEFAULT_PROFILES: AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    startCmd: `claude \${options} -n \${sessionId} "${START_PROMPT}"`,
    startNoPromptCmd: 'claude ${options} -n ${sessionId}',
    resumeCmd: 'claude ${options} --continue',
    modelArg: '--model ${value}',
    effortArg: '--effort ${value}',
    models: ['sonnet', 'opus', 'haiku', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    startCmd: `agy \${options} -i "${START_PROMPT}"`,
    startNoPromptCmd: 'agy ${options}',
    resumeCmd: 'agy ${options} --continue',
    resumeWithIdCmd: 'agy ${options} --conversation ${agentSessionId}',
    modelArg: '--model ${value}',
    models: [
      'gemini-4-neon-medium',
      'gemini-4-neon-high',
      'gemini-4-hydrogen-medium',
      'gemini-4-argon-medium',
      'gemini-pro-orchestrator-neon',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    startCmd: `codex \${options} "${START_PROMPT}"`,
    startNoPromptCmd: 'codex ${options}',
    resumeCmd: 'codex ${options} resume --last',
    modelArg: '-m ${value}',
    effortArg: '-c model_reasoning_effort=${value}',
    models: [],
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
];

// Model names and effort levels are single shell words; they are single-quoted, so brackets ("[1m]") are safe.
const SAFE_VALUE = /^[A-Za-z0-9._:/@[\]-]+$/;
const VALUE = '${value}';

// Whether the pickers apply to this profile: it says how to pass at least one option and has a place for them.
export function supportsOptions(p: AgentProfile): boolean {
  return Boolean(p.modelArg || p.effortArg) && p.startCmd.includes('${options}');
}

// The flags for ${options}, e.g. "--model 'sonnet' --effort 'medium'"; empty without a choice.
export function optionsText(p: AgentProfile, opts: AgentOptions): string {
  const parts: string[] = [];
  for (const [kind, value, arg] of [['model', opts.model, p.modelArg], ['effort', opts.effort, p.effortArg]] as const) {
    if (value === undefined || !arg) {
      continue;
    }
    if (!SAFE_VALUE.test(value)) {
      throw new Error(`invalid ${kind} "${value}": use letters, digits and . _ : / @ [ ] -`);
    }
    parts.push(arg.split(VALUE).join(`'${value}'`));
  }
  return parts.join(' ');
}

// What a fresh start uses when nothing was picked: your configured default per agent, else the profile's own,
// and only for an option the agent can take.
export function defaultOptions(p: AgentProfile, configured: AgentOptions | undefined): AgentOptions {
  const model = p.modelArg ? configured?.model ?? p.defaultModel : undefined;
  const effort = p.effortArg ? configured?.effort ?? p.defaultEffort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export const OTHER = '\u0000other';

export interface OptionChoice {
  value: string | undefined; // undefined = the agent's own default; OTHER = type one
  label: string;
  description?: string;
}

// Picker order: the preselected value first (last used on this ticket, your configured default, the agent's default),
// then the other offered values, then "the agent's own default" (no flag) and "Other…".
export function optionChoices(values: string[], pref: { lastUsed?: string; configured?: string; profileDefault?: string }): OptionChoice[] {
  const first = pref.lastUsed ?? pref.configured ?? pref.profileDefault;
  const defaultValue = pref.configured ?? pref.profileDefault;
  const ordered = [first, ...values].filter((v, i, all): v is string => v !== undefined && all.indexOf(v) === i);
  const choices: OptionChoice[] = ordered.map((v) => ({
    value: v,
    label: v,
    description: v === pref.lastUsed ? 'last used on this ticket' : v === defaultValue ? 'default' : undefined,
  }));
  const own: OptionChoice = { value: undefined, label: "Agent's own default", description: 'no flag: whatever the agent is set to' };
  const other: OptionChoice = { value: OTHER, label: 'Other…', description: 'type a value' };
  // Nothing preferred: no flag is what happens today, so it stays the one Enter accepts.
  return first === undefined ? [own, ...choices, other] : [...choices, own, other];
}

export interface CommandVars {
  sessionId: string;
  branch: string;
  agentSessionId?: string;
}

const PROMPT_FILE = '.workbench/TASK.md';
const PLACEHOLDER = /( ?)\$\{(\w+)\}/g;

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
  if (p.resumeWithIdCmd !== undefined && typeof p.resumeWithIdCmd !== 'string') {
    return `agent profile ${name}: "resumeWithIdCmd" must be a string`;
  }
  if (p.startNoPromptCmd !== undefined && typeof p.startNoPromptCmd !== 'string') {
    return `agent profile ${name}: "startNoPromptCmd" must be a string`;
  }
  for (const key of ['modelArg', 'effortArg'] as const) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !p[key]!.includes(VALUE))) {
      return `agent profile ${name}: "${key}" must contain ${VALUE}`;
    }
  }
  for (const key of ['models', 'efforts'] as const) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || !p[key]!.every((v) => typeof v === 'string' && SAFE_VALUE.test(v)))) {
      return `agent profile ${name}: "${key}" must be a list of single words (letters, digits and . _ : / @ [ ] -)`;
    }
  }
  for (const key of ['defaultModel', 'defaultEffort'] as const) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !SAFE_VALUE.test(p[key]!))) {
      return `agent profile ${name}: "${key}" must be a single word (letters, digits and . _ : / @ [ ] -)`;
    }
  }
  try {
    for (const cmd of [p.startCmd!, p.resumeCmd ?? '', p.resumeWithIdCmd ?? '', p.startNoPromptCmd ?? '']) {
      expandCommand(cmd, { sessionId: '', branch: '', agentSessionId: '' });
    }
  } catch (e) {
    return `agent profile ${name}: ${(e as Error).message}`;
  }
  return undefined;
}

// Single pass, so placeholders inside inserted values are left as they are. An empty ${options} takes the
// space before it along, so "claude ${options} -n x" without a choice is "claude -n x".
export function expandCommand(template: string, vars: CommandVars, options = ''): string {
  const values: Record<string, string> = {
    promptFile: PROMPT_FILE,
    sessionId: vars.sessionId,
    branch: vars.branch,
    options,
    ...(vars.agentSessionId !== undefined ? { agentSessionId: vars.agentSessionId } : {}),
  };
  return template.replace(PLACEHOLDER, (match, space: string, name: string) => {
    if (!(name in values)) {
      throw new Error(`unknown placeholder ${match.trim()} (use \${promptFile}, \${sessionId}, \${branch}, \${options} or \${agentSessionId})`);
    }
    return name === 'options' && options === '' ? '' : space + values[name];
  });
}

// 'start' hands the agent the TASK.md prompt, 'start-bare' opens it with no prompt, 'resume' continues the last conversation.
export type AgentMode = 'start' | 'start-bare' | 'resume';

export function agentCommand(profile: AgentProfile, mode: AgentMode, vars: CommandVars, opts: AgentOptions = {}): string {
  const renderedOpts = optionsText(profile, opts);
  if (mode === 'resume') {
    if (vars.agentSessionId && profile.resumeWithIdCmd) {
      return expandCommand(profile.resumeWithIdCmd, vars, renderedOpts);
    }
    if (!profile.resumeCmd) {
      throw new Error(`${profile.label} has no resume command`);
    }
    return expandCommand(profile.resumeCmd, vars, renderedOpts);
  }
  const template = mode === 'start-bare' ? profile.startNoPromptCmd ?? profile.startCmd : profile.startCmd;
  return expandCommand(template, vars, renderedOpts);
}
