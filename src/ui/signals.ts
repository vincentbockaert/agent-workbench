import * as vscode from 'vscode';
import { StatusPoller } from '../agents/poller';
import { AgentStatus, readStatusFile, shouldNotify, STATUS_FILE } from '../agents/status';
import { statusFile } from '../agents/terminals';
import { Session } from '../sessions/model';

// How often status files are checked besides the file watcher, which can silently fail on big workspaces.
const POLL_MS = 2000;
// After an agent is started in a session, check it every tick for this long even if it looked idle.
const HEAT_MS = 60_000;

// Watches each session's status file and turns it into badge, status bar and notifications.
export class StatusSignals implements vscode.Disposable {
  private readonly statuses = new Map<string, AgentStatus | undefined>();
  private readonly known = new Map<string, Session>();
  // Idle sessions (exited, or no status file yet) are polled rarely; see StatusPoller.
  private readonly poller = new StatusPoller(
    (id) => {
      const session = this.known.get(id);
      if (session) {
        this.reload(session);
      }
    },
    (id) => {
      const state = this.statuses.get(id)?.state;
      return state === undefined || state === 'exited';
    },
  );
  private readonly timer = setInterval(() => void this.poller.tick().catch(() => undefined), POLL_MS);
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly workingBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);

  constructor(
    private readonly sessions: () => Session[],
    private readonly view: vscode.TreeView<unknown>,
    private readonly onChange: () => void,
    private readonly onStatusChange: (session: Session, prev: AgentStatus | undefined, next: AgentStatus | undefined) => void,
  ) {
    this.statusBar.command = 'agentWorkbench.work.focus';
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.workingBar.command = 'agentWorkbench.work.focus';
  }

  // An agent was just started in this session: notice its first status changes quickly.
  expectActivity(sessionId: string): void {
    this.poller.heat(sessionId, HEAT_MS);
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
        this.known.delete(id);
        this.poller.remove(id);
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
        this.known.set(session.id, session);
        this.poller.add(session.id, statusFile(session));
        // Initial read: no notification for states that were already there before this window.
        this.statuses.set(session.id, readStatusFile(statusFile(session)));
      }
    }
    this.updateSummary();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.watchers.forEach((w) => w.dispose());
    this.statusBar.dispose();
    this.workingBar.dispose();
  }

  private reload(session: Session): void {
    // Before reading, so the poller does not report this same change again, but still sees a later one.
    this.poller.note(session.id);
    const prev = this.statuses.get(session.id);
    const next = readStatusFile(statusFile(session));
    this.statuses.set(session.id, next);
    this.onStatusChange(session, prev, next);
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
    const working = [...this.statuses.values()].filter((s) => s?.state === 'working').length;
    this.workingBar.text = `$(sync~spin) ${working} working`;
    this.workingBar.tooltip = `${working} agent${working === 1 ? '' : 's'} working`;
    if (working > 0) {
      this.workingBar.show();
    } else {
      this.workingBar.hide();
    }
  }
}
