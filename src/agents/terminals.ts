import * as vscode from 'vscode';
import { Session } from '../sessions/model';
import { SessionStore } from '../sessions/store';
import { AgentProfile, agentCommand, mergeProfiles } from './profiles';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('agentWorkbench');
}

export function agentProfiles(): { profiles: AgentProfile[]; problems: string[] } {
  return mergeProfiles(config().get<unknown[]>('agents', []));
}

// One agent terminal per session, kept for this window's lifetime; closing it ends the agent.
export class AgentTerminals implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly closeListener: vscode.Disposable;

  constructor(
    private readonly store: SessionStore,
    private readonly onChange: () => void,
  ) {
    this.closeListener = vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of this.terminals) {
        if (term === t) {
          this.terminals.delete(id);
        }
      }
    });
  }

  // Focus the running agent; otherwise resume the last agent used here, or start the default one.
  async open(session: Session): Promise<void> {
    const running = this.terminals.get(session.id);
    if (running) {
      running.show();
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
    this.closeListener.dispose();
  }

  private run(session: Session, profile: AgentProfile, mode: 'start' | 'resume'): void {
    const cmd = agentCommand(profile, mode, { sessionId: session.id, branch: session.branch });
    const terminal = vscode.window.createTerminal({ name: `${profile.label}: ${session.id}`, cwd: session.worktree });
    this.terminals.set(session.id, terminal);
    terminal.show();
    terminal.sendText(cmd);
    if (session.agent !== profile.id) {
      this.store.update(session.id, { agent: profile.id });
      this.onChange();
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
