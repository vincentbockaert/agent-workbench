import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { agentProfiles, AgentTerminals } from './agents/terminals';
import { WORK_VIEW_ID } from './constants';
import { git } from './git/git';
import { deleteSession, startSession, WORKBENCH_DIR } from './sessions/lifecycle';
import { Session } from './sessions/model';
import { SessionStore } from './sessions/store';
import { refreshSource } from './tickets/snapshot';
import { Ticket, TicketSourceConfig } from './tickets/source';
import { promptAdjustment, showTimeReport } from './time/commands';
import { TimeTracker } from './time/tracker';
import { openChange, registerChangeProviders, sessionForEditor } from './ui/changes';
import { StatusSignals } from './ui/signals';
import { WorkNode, WorkTreeProvider } from './ui/tree';

function ticketSources(): TicketSourceConfig[] {
  return vscode.workspace.getConfiguration('agentWorkbench').get<TicketSourceConfig[]>('ticketSources', []);
}

// Ticket commands such as `gh issue list` depend on the current repo, so run them in the workspace.
function commandCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

// The repo of the first workspace folder; sessions of other repos are hidden in this window.
async function currentRepo(): Promise<{ root: string; branch: string } | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    return undefined;
  }
  try {
    const root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await git(root, ['branch', '--show-current'])).trim() || 'HEAD';
    return { root, branch };
  } catch {
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const snapshotDir = path.join(context.globalStorageUri.fsPath, 'tickets');
  const store = new SessionStore(path.join(context.globalStorageUri.fsPath, 'sessions.json'));
  if (store.warning) {
    void vscode.window.showWarningMessage(`Agent Workbench: ${store.warning}`);
  }
  const repoRoot = (await currentRepo())?.root;
  const sessionsHere = () => store.list().filter((s) => s.repo === repoRoot);
  const tree = new WorkTreeProvider(ticketSources, snapshotDir, sessionsHere, (id) => signals.get(id), (key) => tracker.today()[key]);
  const view = vscode.window.createTreeView(WORK_VIEW_ID, { treeDataProvider: tree });
  const logDir = path.join(context.globalStorageUri.fsPath, 'timelog');
  const tracker = new TimeTracker(logDir, sessionsHere, () => tree.refresh());
  const signals = new StatusSignals(sessionsHere, view, () => tree.refresh(), (s, prev, next) => tracker.statusChanged(s, prev, next));
  // Sessions added or removed: re-sync status watchers, then redraw.
  const changed = (): void => {
    signals.sync();
    tree.refresh();
  };
  const agents = new AgentTerminals(store, context.asAbsolutePath('bin/wb.js'), changed, (t, s) => tracker.registerTerminal(t, s));
  signals.sync();

  function reportProfileProblems(): void {
    for (const problem of agentProfiles().problems) {
      void vscode.window.showWarningMessage(`Agent Workbench: ${problem}`);
    }
  }
  reportProfileProblems();

  // Runs a session action and shows its error instead of failing silently.
  async function guarded(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Workbench: ${(e as Error).message}`);
    }
  }

  async function newSession(opts: { ticket?: Ticket; adhoc?: { title: string; description: string } }): Promise<void> {
    const repo = await currentRepo();
    if (!repo) {
      void vscode.window.showErrorMessage('Agent Workbench: open a folder inside a git repository to start sessions.');
      return;
    }
    try {
      const session = await startSession({ repo: repo.root, baseRef: repo.branch, store, ...opts });
      tracker.sessionStarted(session);
      changed();
      if (vscode.workspace.getConfiguration('agentWorkbench').get<boolean>('startAgentOnCreate', true)) {
        await agents.start(session, false);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Workbench: ${(e as Error).message}`);
    }
  }

  // The session a command applies to: the tree node it was invoked on, else the active editor's session.
  function sessionOf(node: WorkNode | undefined): Session | undefined {
    if (node?.kind === 'session' || node?.kind === 'change') {
      return node.session;
    }
    return sessionForEditor(sessionsHere(), vscode.window.activeTextEditor);
  }

  function openShell(session: Session): void {
    const terminal = vscode.window.createTerminal({ name: `wb: ${session.id}`, cwd: session.worktree });
    tracker.registerTerminal(terminal, session);
    terminal.show();
  }

  context.subscriptions.push(
    view,
    signals,
    tracker,

    vscode.commands.registerCommand('agentWorkbench.timeReport', () => guarded(() => showTimeReport(logDir, store.list()))),

    vscode.commands.registerCommand('agentWorkbench.adjustTime', async (node: WorkNode) => {
      if (node?.kind === 'session') {
        const adjustment = await promptAdjustment(node.session);
        if (adjustment) {
          tracker.adjust(node.session, adjustment.minutes, adjustment.note);
        }
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.refreshTickets', () =>
      vscode.window.withProgress({ location: { viewId: WORK_VIEW_ID } }, async () => {
        const now = new Date();
        await Promise.all(ticketSources().map((cfg) => refreshSource(cfg, commandCwd(), snapshotDir, now)));
        changed();
      }),
    ),

    vscode.commands.registerCommand('agentWorkbench.openTicketInBrowser', (node: WorkNode) => {
      if (node?.kind === 'ticket' && node.group.ticket.url) {
        void vscode.env.openExternal(vscode.Uri.parse(node.group.ticket.url));
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.newSessionForTicket', (node: WorkNode) => {
      if (node?.kind === 'ticket' && node.group.listed) {
        return newSession({ ticket: node.group.ticket as Ticket });
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.newAdhocSession', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Ad-hoc session title', placeHolder: 'Try the new parser' });
      if (!title?.trim()) {
        return;
      }
      const description = await vscode.window.showInputBox({ prompt: 'What should the agent do? (optional)' });
      if (description === undefined) {
        return;
      }
      return newSession({ adhoc: { title: title.trim(), description } });
    }),

    vscode.commands.registerCommand('agentWorkbench.openSessionShell', (node?: WorkNode) => {
      const session = sessionOf(node);
      if (session) {
        openShell(session);
      }
    }),

    agents,

    vscode.commands.registerCommand('agentWorkbench.openAgent', (node?: WorkNode) => {
      const session = sessionOf(node);
      return session ? guarded(() => agents.open(session)) : undefined;
    }),

    registerChangeProviders(),

    vscode.commands.registerCommand('agentWorkbench.openChange', (node: WorkNode) =>
      node?.kind === 'change' ? guarded(() => openChange(node.session, node.file)) : undefined,
    ),

    // Types the push + PR command into the session's shell without running it: you review and press Enter.
    vscode.commands.registerCommand('agentWorkbench.createPullRequest', (node?: WorkNode) => {
      const session = sessionOf(node);
      if (!session) {
        return;
      }
      const terminal = vscode.window.createTerminal({ name: `PR: ${session.id}`, cwd: session.worktree });
      tracker.registerTerminal(terminal, session);
      terminal.show();
      terminal.sendText(`git push -u origin ${session.branch} && gh pr create --fill --head ${session.branch}`, false);
      void vscode.window.showInformationMessage(`Review the command in the "PR: ${session.id}" terminal and press Enter to push and open the pull request.`);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand('setContext', 'agentWorkbench.inSession', sessionForEditor(sessionsHere(), editor) !== undefined);
    }),

    vscode.commands.registerCommand('agentWorkbench.startAgent', (node: WorkNode) =>
      node?.kind === 'session' ? guarded(() => agents.start(node.session, true)) : undefined,
    ),

    vscode.commands.registerCommand('agentWorkbench.resumeAgent', (node: WorkNode) =>
      node?.kind === 'session' ? guarded(() => agents.resume(node.session)) : undefined,
    ),

    vscode.commands.registerCommand('agentWorkbench.openSessionTask', async (node: WorkNode) => {
      if (node?.kind === 'session') {
        const file = vscode.Uri.file(path.join(node.session.worktree, WORKBENCH_DIR, 'TASK.md'));
        await vscode.window.showTextDocument(file, { preview: true });
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.deleteSession', async (node: WorkNode) => {
      if (node?.kind !== 'session') {
        return;
      }
      const s = node.session;
      const ok = await vscode.window.showWarningMessage(
        `Delete session ${s.id}? Its worktree folder is removed; branch ${s.branch} is kept.`,
        { modal: true },
        'Delete',
      );
      if (ok !== 'Delete') {
        return;
      }
      try {
        await deleteSession(store, s);
      } catch (e) {
        const force = await vscode.window.showWarningMessage(
          `${s.id} has uncommitted changes that will be lost.`,
          { modal: true, detail: (e as Error).message },
          'Delete Anyway',
        );
        if (force !== 'Delete Anyway') {
          return;
        }
        await deleteSession(store, s, { force: true });
      }
      tracker.sessionEnded(s);
      changed();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentWorkbench.ticketSources')) {
        changed();
      }
      if (e.affectsConfiguration('agentWorkbench.time')) {
        tree.refresh();
      }
      if (e.affectsConfiguration('agentWorkbench.agents')) {
        reportProfileProblems();
      }
    }),
  );
}

export function deactivate(): void {}
