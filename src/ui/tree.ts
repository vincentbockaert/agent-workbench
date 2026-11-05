import * as path from 'path';
import * as vscode from 'vscode';
import { AgentState, AgentStatus, describeSince } from '../agents/status';
import { diffStats, LineStats } from '../git/diff';
import { ChangedFile, changedFiles } from '../git/worktree';
import { Session } from '../sessions/model';
import { changeUri } from './changes';
import { displayedMs } from '../time/commands';
import { sumTotals, Totals } from '../time/compute';
import { formatDuration } from '../time/report';
import { ticketKey, ticketKeyOf } from '../time/rules';
import { describeAge, readSnapshot } from '../tickets/snapshot';
import { TicketSourceConfig } from '../tickets/source';
import { WORK_LABELS, WorkStatus } from '../tickets/workflow';
import { filterWork, groupWork, SourceGroup, TicketGroup } from './group';

export type WorkNode =
  | { kind: 'source'; group: SourceGroup }
  | { kind: 'error'; message: string }
  | { kind: 'ticket'; group: TicketGroup }
  | { kind: 'other'; sessions: Session[] }
  | { kind: 'session'; session: Session }
  | { kind: 'change'; session: Session; file: ChangedFile; stats?: LineStats }
  | { kind: 'today' }
  | { kind: 'figure'; label: string; ms: number; icon: string; color: string; tooltip: string };

// Renders only from snapshots and the session store, so the tree works offline and never runs commands itself.
export class WorkTreeProvider implements vscode.TreeDataProvider<WorkNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly sources: () => TicketSourceConfig[],
    private readonly snapshotDir: string,
    private readonly sessions: () => Session[],
    private readonly status: (sessionId: string) => AgentStatus | undefined,
    private readonly today: () => Record<string, Totals>,
    private readonly workStatus: (ticketKey: string) => WorkStatus,
  ) {}

  // "Hide Done Tickets" toggle.
  hideDone = false;

  private todayLabel(key: string): string | undefined {
    const ms = displayedMs(this.today()[key]);
    return ms >= 60_000 ? `${formatDuration(ms)} today` : undefined;
  }

  // Text from "Filter Tickets…"; empty = show all.
  filter = '';

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: WorkNode): WorkNode[] | Promise<WorkNode[]> {
    if (!node) {
      const sources = this.sources();
      const grouped = groupWork(sources, sources.map((cfg) => readSnapshot(this.snapshotDir, cfg.name)), this.sessions());
      const model = filterWork(grouped, this.filter, { workStatus: this.workStatus, hideDone: this.hideDone });
      const roots: WorkNode[] = model.sources.map((group) => ({ kind: 'source', group }));
      // Shown whenever there is anything else, so "new ad-hoc session" has a visible home.
      if (roots.length > 0 || model.other.length > 0) {
        roots.push({ kind: 'other', sessions: model.other }, { kind: 'today' });
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
      case 'today': {
        const sum = sumTotals(this.today());
        return [
          { kind: 'figure', label: 'Elapsed', ms: sum.elapsedMs, icon: 'watch', color: 'descriptionForeground', tooltip: 'You or an agent worked on a ticket; overlaps within a ticket counted once.' },
          { kind: 'figure', label: 'You', ms: sum.yourMs, icon: 'person', color: 'charts.blue', tooltip: 'Time you were active in sessions, plus adjustments.' },
          { kind: 'figure', label: 'Agents', ms: sum.agentMs, icon: 'hubot', color: 'charts.purple', tooltip: 'Time agents were working.' },
        ];
      }
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
        const key = ticketKeyOf(ticket.source, ticket.id);
        const work = this.workStatus(key);
        // The tracker's status is read-only (last import); the workbench status is yours.
        const tracker = listed ? ('status' in ticket && ticket.status ? `${ticket.source}: ${ticket.status}` : undefined) : 'not in list';
        item.description = [WORK_LABELS[work], tracker, this.todayLabel(key)].filter(Boolean).join(' · ');
        item.tooltip = new vscode.MarkdownString(`**${ticket.id}** ${ticket.title}\n\nWorkbench: ${WORK_LABELS[work]}${tracker ? `  \nTracker (read-only): ${tracker}` : ''}${ticket.url ? `\n\n${ticket.url}` : ''}`);
        // A collapsed ticket still shows when one of its sessions is waiting for you.
        const waiting = sessions.some((s) => this.status(s.id)?.state === 'needs-input');
        item.iconPath = waiting ? STATE_ICONS['needs-input'] : WORK_ICONS[work];
        // e.g. "ticket", "ticketWithUrl", "ticketUnlistedWithUrl": menus match on these.
        item.contextValue = `ticket${listed ? '' : 'Unlisted'}${ticket.url ? 'WithUrl' : ''}`;
        item.command = { command: 'agentWorkbench.openTicketHub', title: 'Open Ticket', arguments: [node] };
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
        const status = this.status(s.id);
        const state = status && `${STATE_SHORT[status.state]} · ${describeSince(status, new Date())}`;
        // Ad-hoc sessions sit outside any repo group, so name their repo; ticket sessions show it via their source.
        item.description = [s.title ? s.id : undefined, s.ticket ? undefined : path.basename(s.repo), s.agent, state, today].filter(Boolean).join(' · ');
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
      case 'today': {
        // Summed over tickets: what you book. The headline is the configured booked figure.
        const item = new vscode.TreeItem('Today', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${formatDuration(displayedMs(sumTotals(this.today())))} booked`;
        item.iconPath = new vscode.ThemeIcon('clock');
        item.tooltip = 'Totals over all tickets today. Click the clock in the title bar for the full report.';
        item.contextValue = 'today';
        return item;
      }
      case 'figure': {
        const item = new vscode.TreeItem(node.label);
        item.description = formatDuration(node.ms);
        item.iconPath = new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(node.color));
        item.tooltip = node.tooltip;
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

const WORK_ICONS: Record<WorkStatus, vscode.ThemeIcon> = {
  todo: new vscode.ThemeIcon('circle-large-outline'),
  doing: new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue')),
  review: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.purple')),
  done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
};

const STATE_SHORT: Record<AgentState, string> = {
  'needs-input': 'needs input',
  working: 'working',
  done: 'your move',
  exited: 'stopped',
};

const STATE_LABELS: Record<AgentState, string> = {
  'needs-input': 'Needs your input',
  working: 'Working',
  done: 'Turn done, your move',
  exited: 'Agent not running',
};
