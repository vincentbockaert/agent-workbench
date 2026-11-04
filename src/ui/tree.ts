import * as vscode from 'vscode';
import { Session } from '../sessions/model';
import { describeAge, readSnapshot } from '../tickets/snapshot';
import { TicketSourceConfig } from '../tickets/source';
import { groupWork, SourceGroup, TicketGroup } from './group';

export type WorkNode =
  | { kind: 'source'; group: SourceGroup }
  | { kind: 'error'; message: string }
  | { kind: 'ticket'; group: TicketGroup }
  | { kind: 'other'; sessions: Session[] }
  | { kind: 'session'; session: Session };

// Renders only from snapshots and the session store, so the tree works offline and never runs commands itself.
export class WorkTreeProvider implements vscode.TreeDataProvider<WorkNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly sources: () => TicketSourceConfig[],
    private readonly snapshotDir: string,
    private readonly sessions: () => Session[],
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: WorkNode): WorkNode[] {
    if (!node) {
      const sources = this.sources();
      const model = groupWork(sources, sources.map((cfg) => readSnapshot(this.snapshotDir, cfg.name)), this.sessions());
      const roots: WorkNode[] = model.sources.map((group) => ({ kind: 'source', group }));
      // Shown whenever there is anything else, so "new ad-hoc session" has a visible home.
      if (roots.length > 0 || model.other.length > 0) {
        roots.push({ kind: 'other', sessions: model.other });
      }
      return roots;
    }
    switch (node.kind) {
      case 'source': {
        const children: WorkNode[] = [];
        if (node.group.snap?.error) {
          children.push({ kind: 'error', message: node.group.snap.error.message });
        }
        return children.concat(node.group.tickets.map((group) => ({ kind: 'ticket', group })));
      }
      case 'ticket':
        return node.group.sessions.map((session) => ({ kind: 'session', session }));
      case 'other':
        return node.sessions.map((session) => ({ kind: 'session', session }));
      default:
        return [];
    }
  }

  getTreeItem(node: WorkNode): vscode.TreeItem {
    switch (node.kind) {
      case 'source': {
        const { cfg, snap } = node.group;
        const item = new vscode.TreeItem(cfg.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${snap?.tickets.length ?? 0} · ${describeAge(snap?.fetchedAt, new Date())}`;
        item.iconPath = new vscode.ThemeIcon(snap?.error ? 'warning' : 'list-unordered');
        item.contextValue = 'source';
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(node.message);
        item.tooltip = node.message;
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        return item;
      }
      case 'ticket': {
        const { ticket, listed, sessions } = node.group;
        const state = sessions.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(`${ticket.id} ${ticket.title}`, state);
        const status = 'status' in ticket ? ticket.status : undefined;
        item.description = listed ? status : 'not in list';
        item.tooltip = new vscode.MarkdownString(`**${ticket.id}** ${ticket.title}\n\n${status ?? ''}${ticket.url ? `\n\n${ticket.url}` : ''}`);
        item.iconPath = new vscode.ThemeIcon(listed ? 'issues' : 'issue-closed');
        // e.g. "ticket", "ticketWithUrl", "ticketUnlistedWithUrl": menus match on these.
        item.contextValue = `ticket${listed ? '' : 'Unlisted'}${ticket.url ? 'WithUrl' : ''}`;
        return item;
      }
      case 'other': {
        const state = node.sessions.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem('Ad-hoc', state);
        item.iconPath = new vscode.ThemeIcon('beaker');
        item.contextValue = 'other';
        return item;
      }
      case 'session': {
        const s = node.session;
        const item = new vscode.TreeItem(s.title ?? s.id);
        item.description = s.title ? s.id : s.branch;
        item.tooltip = `${s.branch}\n${s.worktree}\nbased on ${s.baseRef}, created ${s.createdAt}`;
        item.iconPath = new vscode.ThemeIcon('git-branch');
        item.contextValue = 'session';
        item.command = { command: 'agentWorkbench.openSessionTask', title: 'Open Task', arguments: [node] };
        return item;
      }
    }
  }
}
