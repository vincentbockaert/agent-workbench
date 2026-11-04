import * as vscode from 'vscode';
import { AgentStatus, readStatusFile, shouldNotify, STATUS_FILE } from '../agents/status';
import { statusFile } from '../agents/terminals';
import { Session } from '../sessions/model';

// Watches each session's status file and turns it into badge, status bar and notifications.
export class StatusSignals implements vscode.Disposable {
  private readonly statuses = new Map<string, AgentStatus | undefined>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor(
    private readonly sessions: () => Session[],
    private readonly view: vscode.TreeView<unknown>,
    private readonly onChange: () => void,
  ) {
    this.statusBar.command = 'agentWorkbench.work.focus';
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  get(sessionId: string): AgentStatus | undefined {
    return this.statuses.get(sessionId);
  }

  // Call whenever the session list may have changed: adds and removes watchers to match it.
  sync(): void {
    const current = new Map(this.sessions().map((s) => [s.id, s]));
    for (const [id, watcher] of this.watchers) {
      if (!current.has(id)) {
        watcher.dispose();
        this.watchers.delete(id);
        this.statuses.delete(id);
      }
    }
    for (const session of current.values()) {
      if (!this.watchers.has(session.id)) {
        const pattern = new vscode.RelativePattern(vscode.Uri.file(session.worktree), STATUS_FILE);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const reload = () => this.reload(session);
        watcher.onDidCreate(reload);
        watcher.onDidChange(reload);
        watcher.onDidDelete(reload);
        this.watchers.set(session.id, watcher);
        // Initial read: no notification for states that were already there before this window.
        this.statuses.set(session.id, readStatusFile(statusFile(session)));
      }
    }
    this.updateSummary();
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.statusBar.dispose();
  }

  private reload(session: Session): void {
    const prev = this.statuses.get(session.id);
    const next = readStatusFile(statusFile(session));
    this.statuses.set(session.id, next);
    if (next && shouldNotify(prev?.state, next.state) && vscode.workspace.getConfiguration('agentWorkbench').get('notifyOnNeedsInput', true)) {
      void vscode.window
        .showWarningMessage(`${session.title ?? session.id} needs your input${next.message ? `: ${next.message}` : ''}`, 'Open Agent')
        .then((choice) => {
          if (choice === 'Open Agent') {
            void vscode.commands.executeCommand('agentWorkbench.openAgent', { kind: 'session', session });
          }
        });
    }
    this.updateSummary();
    this.onChange();
  }

  private updateSummary(): void {
    const waiting = [...this.statuses.values()].filter((s) => s?.state === 'needs-input').length;
    const label = `${waiting} session${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} your input`;
    this.view.badge = waiting > 0 ? { value: waiting, tooltip: label } : undefined;
    this.statusBar.text = `$(bell-dot) ${waiting}`;
    this.statusBar.tooltip = label;
    if (waiting > 0) {
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }
}
