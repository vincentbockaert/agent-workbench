import * as vscode from 'vscode';
import { AgentState, AgentStatus } from '../agents/status';
import { diffStats, LineStats } from '../git/diff';
import { ChangedFile, changedFiles } from '../git/worktree';
import { Session } from '../sessions/model';
import { changeUri } from './changes';
import { displayedMs } from '../time/commands';
import { Totals } from '../time/compute';
import { formatDuration } from '../time/report';
import { ticketKey, ticketKeyOf } from '../time/rules';
import { describeAge, readSnapshot } from '../tickets/snapshot';
import { TicketSourceConfig } from '../tickets/source';
import { groupWork, SourceGroup, TicketGroup } from './group';

export type WorkNode =
  | { kind: 'source'; group: SourceGroup }
  | { kind: 'error'; message: string }
  | { kind: 'ticket'; group: TicketGroup }
  | { kind: 'other'; sessions: Session[] }
  | { kind: 'session'; session: Session }
  | { kind: 'change'; session: Session; file: ChangedFile; stats?: LineStats };

// Renders only from snapshots and the session store, so the tree works offline and never runs commands itself.
export class WorkTreeProvider implements vscode.TreeDataProvider<WorkNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly sources: () => TicketSourceConfig[],
    private readonly snapshotDir: string,
    private readonly sessions: () => Session[],
    private readonly status: (sessionId: string) => AgentStatus | undefined,
    private readonly timeToday: (ticketKey: string) => Totals | undefined,
  ) {}

  private todayLabel(key: string): string | undefined {
    const ms = displayedMs(this.timeToday(key));
    return ms >= 60_000 ? `${formatDuration(ms)} today` : undefined;
  }

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: WorkNode): WorkNode[] | Promise<WorkNode[]> {
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
      case 'session':
        return this.changes(node.session);
      default:
        return [];
    }
  }

  // Only runs git when a session is expanded; a missing or broken worktree shows no children.
  private async changes(session: Session): Promise<WorkNode[]> {
    try {
      const [files, stats] = await Promise.all([changedFiles(session.worktree, session.baseRef), diffStats(session.worktree, session.baseRef)]);
      return files.map((file) => ({ kind: 'change', session, file, stats: stats.get(file.path) }));
    } catch {
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
        item.description = [listed ? status : 'not in list', this.todayLabel(ticketKeyOf(ticket.source, ticket.id))].filter(Boolean).join(' · ');
        item.tooltip = new vscode.MarkdownString(`**${ticket.id}** ${ticket.title}\n\n${status ?? ''}${ticket.url ? `\n\n${ticket.url}` : ''}`);
        // A collapsed ticket still shows when one of its sessions is waiting for you.
        const waiting = sessions.some((s) => this.status(s.id)?.state === 'needs-input');
        item.iconPath = waiting ? STATE_ICONS['needs-input'] : new vscode.ThemeIcon(listed ? 'issues' : 'issue-closed');
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
        // Collapsed by default: expanding runs git to list the changed files.
        const item = new vscode.TreeItem(s.title ?? s.id, vscode.TreeItemCollapsibleState.Collapsed);
        // Ticket sessions book on their ticket (shown there); ad-hoc sessions show their own time.
        const today = s.ticket ? undefined : this.todayLabel(ticketKey(s));
        item.description = [s.title ? s.id : s.branch, s.agent, today].filter(Boolean).join(' · ');
        const status = this.status(s.id);
        item.tooltip = [
          status && `${STATE_LABELS[status.state]}${status.message ? `: ${status.message}` : ''}`,
          s.branch,
          s.worktree,
          `based on ${s.baseRef}, created ${s.createdAt}`,
        ]
          .filter(Boolean)
          .join('\n');
        item.iconPath = status ? STATE_ICONS[status.state] : new vscode.ThemeIcon('git-branch');
        item.contextValue = 'session';
        item.command = { command: 'agentWorkbench.openSessionTask', title: 'Open Task', arguments: [node] };
        return item;
      }
      case 'change': {
        const { file, stats } = node;
        const item = new vscode.TreeItem(file.path);
        // A custom scheme carries the status, so the decoration provider can add the M/A/D/U letter and color,
        // while the file icon theme still picks the icon from the extension.
        item.resourceUri = changeUri(file);
        item.description = stats ? `+${stats.added} −${stats.removed}` : 'binary';
        item.tooltip = `${file.status}: ${file.path}`;
        item.contextValue = 'change';
        item.command = { command: 'agentWorkbench.openChange', title: 'Open Changes', arguments: [node] };
        return item;
      }
    }
  }
}

const STATE_ICONS: Record<AgentState, vscode.ThemeIcon> = {
  'needs-input': new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange')),
  working: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue')),
  done: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
  exited: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
};

const STATE_LABELS: Record<AgentState, string> = {
  'needs-input': 'Needs your input',
  working: 'Working',
  done: 'Turn done, your move',
  exited: 'Agent not running',
};
