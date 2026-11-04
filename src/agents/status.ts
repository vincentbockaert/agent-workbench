import * as fs from 'fs';
import * as path from 'path';
import { formatDuration } from '../time/report';

export type AgentState = 'working' | 'needs-input' | 'done' | 'exited';

export interface AgentStatus {
  state: AgentState;
  at: string; // last write
  since?: string; // when the current state began; older files lack it
  message?: string;
  agentSessionId?: string;
}

export const STATUS_FILE = '.workbench/status.json';
// Claude reads this per-folder file automatically; a fresh worktree never has one (it is untracked).
export const CLAUDE_SETTINGS_FILE = '.claude/settings.local.json';

const STATES: AgentState[] = ['working', 'needs-input', 'done', 'exited'];

// Returns undefined for anything that is not a valid status, so a bad file never breaks the view.
export function parseStatus(text: string): AgentStatus | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return undefined;
  }
  const s = v as Partial<AgentStatus>;
  if (!STATES.includes(s.state as AgentState) || typeof s.at !== 'string') {
    return undefined;
  }
  return s as AgentStatus;
}

// How long the session has been in its current state, for the tree: "now", "4m", "1h 05m".
export function describeSince(status: AgentStatus, now: Date): string {
  const ms = now.getTime() - Date.parse(status.since ?? status.at);
  return ms < 60_000 ? 'now' : formatDuration(ms);
}

export function shouldNotify(prev: AgentState | undefined, next: AgentState): boolean {
  return next === 'needs-input' && prev !== 'needs-input';
}

export function readStatusFile(file: string): AgentStatus | undefined {
  try {
    return parseStatus(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Used by the extension's own fallback (terminal ended/closed); hooks write via wb.js.
export function writeStatusFile(file: string, status: AgentStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(status));
  fs.renameSync(`${file}.tmp`, file);
}

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

// Claude Code settings (loaded with --settings) whose hooks call wb.js.
// Forward slashes and quotes keep the path valid in both bash and Windows shells.
export function claudeHookSettings(wbScript: string): object {
  const command = `node "${wbScript.replace(/\\/g, '/')}" hook claude`;
  const hooks: Record<string, unknown> = {};
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command }] }];
  }
  return { hooks };
}
