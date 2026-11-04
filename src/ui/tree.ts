import * as vscode from 'vscode';
import { describeAge, readSnapshot, Snapshot } from '../tickets/snapshot';
import { Ticket, TicketSourceConfig } from '../tickets/source';

type Node =
  | { kind: 'source'; cfg: TicketSourceConfig; snap?: Snapshot }
  | { kind: 'error'; message: string }
  | { kind: 'ticket'; ticket: Ticket };

// Renders only from snapshots on disk, so the tree works offline and never runs commands itself.
export class WorkTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly sources: () => TicketSourceConfig[],
    private readonly snapshotDir: string,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.sources().map((cfg) => ({ kind: 'source', cfg, snap: readSnapshot(this.snapshotDir, cfg.name) }));
    }
    if (node.kind !== 'source') {
      return [];
    }
    const children: Node[] = [];
    if (node.snap?.error) {
      children.push({ kind: 'error', message: node.snap.error.message });
    }
    for (const ticket of node.snap?.tickets ?? []) {
      children.push({ kind: 'ticket', ticket });
    }
    return children;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'source': {
        const item = new vscode.TreeItem(node.cfg.name, vscode.TreeItemCollapsibleState.Expanded);
        const count = node.snap?.tickets.length ?? 0;
        item.description = `${count} · ${describeAge(node.snap?.fetchedAt, new Date())}`;
        item.iconPath = new vscode.ThemeIcon(node.snap?.error ? 'warning' : 'list-unordered');
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
        const t = node.ticket;
        const item = new vscode.TreeItem(`${t.id} ${t.title}`);
        item.description = t.status;
        item.tooltip = new vscode.MarkdownString(`**${t.id}** ${t.title}\n\n${t.status ?? ''}${t.url ? `\n\n${t.url}` : ''}`);
        item.iconPath = new vscode.ThemeIcon('issues');
        item.contextValue = t.url ? 'ticketWithUrl' : 'ticket';
        return item;
      }
    }
  }
}

export type WorkNode = Node;
