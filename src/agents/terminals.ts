import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session } from '../sessions/model';
import { SessionStore } from '../sessions/store';
import { AgentProfile, agentCommand, mergeProfiles } from './profiles';
import { AgentState, CLAUDE_SETTINGS_FILE, claudeHookSettings, readStatusFile, STATUS_FILE, writeStatusFile } from './status';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('agentWorkbench');
}

export function agentProfiles(): { profiles: AgentProfile[]; problems: string[] } {
  return mergeProfiles(config().get<unknown[]>('agents', []));
}

export function statusFile(session: Session): string {
  return path.join(session.worktree, STATUS_FILE);
}

// One agent terminal per session, kept for this window's lifetime; closing it ends the agent.
export class AgentTerminals implements vscode.Disposable {
  private readonly terminals = new Map<string, { terminal: vscode.Terminal; session: Session }>();
  private readonly listeners: vscode.Disposable[];

  constructor(
    private readonly store: SessionStore,
    private readonly wbScript: string,
    private readonly onChange: () => void,
    private readonly onTerminal: (terminal: vscode.Terminal, session: Session) => void,
  ) {
    // Fallback for agents without hooks: the shell tells us when the agent command starts and ends.
    this.listeners = [
      vscode.window.onDidStartTerminalShellExecution((e) => this.fallback(e.terminal, 'working')),
      vscode.window.onDidEndTerminalShellExecution((e) => this.fallback(e.terminal, 'exited')),
      vscode.window.onDidCloseTerminal((t) => {
        this.fallback(t, 'exited');
        for (const [id, entry] of this.terminals) {
          if (entry.terminal === t) {
            this.terminals.delete(id);
          }
        }
      }),
    ];
  }

  // Focus the running agent; otherwise resume the last agent used here, or start the default one.
  async open(session: Session): Promise<void> {
    const running = this.terminals.get(session.id);
    if (running) {
      running.terminal.show();
      return;
    }
    if (session.agent) {
      await this.resume(session);
    } else {
      await this.start(session, false);
    }
  }

  async start(session: Session, pick: boolean): Promise<void> {
    const profile = pick ? await this.pickProfile() : this.defaultProfile();
    if (profile) {
      this.run(session, profile, 'start');
    }
  }

  startWith(session: Session, profile: AgentProfile): void {
    this.run(session, profile, 'start');
  }

  async resume(session: Session): Promise<void> {
    if (!session.agent) {
      throw new Error(`no agent has run in ${session.id} yet; use "Open Agent" to start one`);
    }
    const profile = agentProfiles().profiles.find((p) => p.id === session.agent);
    if (!profile) {
      throw new Error(`agent profile "${session.agent}" no longer exists; use "Start New Agent Conversation"`);
    }
    this.run(session, profile, 'resume');
  }

  dispose(): void {
    this.listeners.forEach((l) => l.dispose());
  }

  private run(session: Session, profile: AgentProfile, mode: 'start' | 'resume'): void {
    const cmd = agentCommand(profile, mode, { sessionId: session.id, branch: session.branch });
    this.installClaudeHooks(session);
    const terminal = vscode.window.createTerminal({
      name: `${profile.label}: ${session.id}`,
      cwd: session.worktree,
      // wb.js (called from agent hooks) writes the session's status here.
      env: { WB_STATUS_FILE: statusFile(session), WB_SESSION_ID: session.id },
    });
    this.terminals.set(session.id, { terminal, session });
    this.onTerminal(terminal, session);
    terminal.show();
    terminal.sendText(cmd);
    if (session.agent !== profile.id) {
      this.store.update(session.id, { agent: profile.id });
      this.onChange();
    }
  }

  // Rewritten on every run so the hook path follows extension updates. Other agents ignore this file.
  private installClaudeHooks(session: Session): void {
    const file = path.join(session.worktree, CLAUDE_SETTINGS_FILE);
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`${file} is not valid JSON; fix or delete it so status hooks can be added`);
      }
    }
    const ours = claudeHookSettings(this.wbScript) as { hooks: Record<string, unknown> };
    settings.hooks = { ...(settings.hooks as Record<string, unknown> | undefined), ...ours.hooks };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }

  private fallback(terminal: vscode.Terminal, state: AgentState): void {
    for (const { terminal: t, session } of this.terminals.values()) {
      if (t !== terminal) {
        continue;
      }
      const file = statusFile(session);
      const current = readStatusFile(file)?.state;
      // Hooks are more precise; only fill in what they cannot know (start without hooks, process exit).
      if ((state === 'working' && (current === undefined || current === 'exited')) || (state === 'exited' && current !== 'exited')) {
        const at = new Date().toISOString();
        writeStatusFile(file, { state, at, since: at });
      }
    }
  }

  private defaultProfile(): AgentProfile {
    const { profiles } = agentProfiles();
    const id = config().get<string>('defaultAgent', 'claude');
    const profile = profiles.find((p) => p.id === id);
    if (!profile) {
      throw new Error(`default agent "${id}" is not a known agent profile`);
    }
    return profile;
  }

  private async pickProfile(): Promise<AgentProfile | undefined> {
    const { profiles } = agentProfiles();
    if (profiles.length === 1) {
      return profiles[0];
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.label, description: p.id, profile: p })),
      { placeHolder: 'Which agent?' },
    );
    return picked?.profile;
  }
}
