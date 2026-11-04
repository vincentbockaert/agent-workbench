import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { AgentStatus } from '../agents/status';
import { diffStats } from '../git/diff';
import { changedFiles } from '../git/worktree';
import { Session } from '../sessions/model';
import { reportOptions } from '../time/commands';
import { readEvents } from '../time/log';
import { localDays } from '../time/report';
import { ticketKey } from '../time/rules';
import { buildTicketHub, HubInput, HubTicket } from './model';
import { HubMessage, parseHubMessage, renderTicketHub } from './render';

export interface HubDeps {
  sessions: () => Session[];
  status: (sessionId: string) => AgentStatus | undefined;
  logDir: string;
  findTicket: (key: string) => HubTicket | undefined;
  onMessage: (key: string, msg: HubMessage, session: Session | undefined) => void;
}

// One editor tab per ticket. Re-rendered when anything changes, but only if what it shows changed,
// so the page does not jump while you read it.
export class TicketHubs implements vscode.Disposable {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; lastModel?: string }>();
  private pending?: NodeJS.Timeout;

  constructor(private readonly deps: HubDeps) {}

  open(key: string): void {
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const ticket = this.deps.findTicket(key);
    if (!ticket) {
      void vscode.window.showWarningMessage(`Agent Workbench: ticket ${key} is not known; refresh tickets first.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentWorkbench.ticketHub', ticket.id, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    const entry: { panel: vscode.WebviewPanel; lastModel?: string } = { panel };
    this.panels.set(key, entry);
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage((raw) => {
      const msg = parseHubMessage(raw);
      if (msg) {
        const session = 'session' in msg ? this.deps.sessions().find((s) => s.id === msg.session) : undefined;
        this.deps.onMessage(key, msg, session);
      }
    });
    void this.render(key, entry);
  }

  // Debounced: status files can change several times a second while an agent works.
  refreshAll(): void {
    if (this.panels.size === 0 || this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const [key, entry] of this.panels) {
        void this.render(key, entry);
      }
    }, 1000);
  }

  dispose(): void {
    clearTimeout(this.pending);
    this.panels.forEach((p) => p.panel.dispose());
  }

  private async render(key: string, entry: { panel: vscode.WebviewPanel; lastModel?: string }): Promise<void> {
    const ticket = this.deps.findTicket(key);
    if (!ticket) {
      return;
    }
    const sessions = this.deps.sessions().filter((s) => ticketKey(s) === key);
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const week = localDays(monday, new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6));
    const { events } = readEvents(this.deps.logDir, { start: week[0].start, end: week[6].end });

    const input: HubInput = { ticket, sessions, statuses: {}, changes: {}, events, week, now, opts: reportOptions() };
    await Promise.all(
      sessions.map(async (s) => {
        input.statuses[s.id] = this.deps.status(s.id);
        try {
          const [files, stats] = await Promise.all([changedFiles(s.worktree, s.baseRef), diffStats(s.worktree, s.baseRef)]);
          let added = 0;
          let removed = 0;
          stats.forEach((st) => {
            added += st.added;
            removed += st.removed;
          });
          input.changes[s.id] = { files: files.length, added, removed };
        } catch {
          // worktree gone or git failed: show no changes
        }
      }),
    );

    const model = buildTicketHub(input);
    const serialized = JSON.stringify(model);
    if (serialized === entry.lastModel) {
      return;
    }
    entry.lastModel = serialized;
    entry.panel.title = ticket.id;
    entry.panel.webview.html = renderTicketHub(model, randomBytes(16).toString('hex'), entry.panel.webview.cspSource);
  }
}
