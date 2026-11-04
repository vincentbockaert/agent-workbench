import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WORK_VIEW_ID } from './constants';
import { refreshSource } from './tickets/snapshot';
import { TicketSourceConfig } from './tickets/source';
import { WorkNode, WorkTreeProvider } from './ui/tree';

function ticketSources(): TicketSourceConfig[] {
  return vscode.workspace.getConfiguration('agentWorkbench').get<TicketSourceConfig[]>('ticketSources', []);
}

// Ticket commands such as `gh issue list` depend on the current repo, so run them in the workspace.
function commandCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export function activate(context: vscode.ExtensionContext): void {
  const snapshotDir = path.join(context.globalStorageUri.fsPath, 'tickets');
  const tree = new WorkTreeProvider(ticketSources, snapshotDir);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(WORK_VIEW_ID, tree),

    vscode.commands.registerCommand('agentWorkbench.refreshTickets', () =>
      vscode.window.withProgress({ location: { viewId: WORK_VIEW_ID } }, async () => {
        const now = new Date();
        await Promise.all(ticketSources().map((cfg) => refreshSource(cfg, commandCwd(), snapshotDir, now)));
        tree.refresh();
      }),
    ),

    vscode.commands.registerCommand('agentWorkbench.openTicketInBrowser', (node: WorkNode) => {
      if (node?.kind === 'ticket' && node.ticket.url) {
        void vscode.env.openExternal(vscode.Uri.parse(node.ticket.url));
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentWorkbench.ticketSources')) {
        tree.refresh();
      }
    }),
  );
}

export function deactivate(): void {}
