import * as vscode from 'vscode';
import { AgentStatus } from '../agents/status';
import { Session } from '../sessions/model';
import { BEAT_MS, ClockTracker } from './clock';
import { Totals, totalsByTicket } from './compute';
import { TimeEvent, TimeEventType } from './events';
import { appendEvent, readEvents } from './log';
import { localDays } from './report';
import { eventsForStatusChange, sessionForPath, ticketKey } from './rules';

const HEARTBEAT_MS = 30_000; // well below the idle limit, so throttling never loses time
// Another window of this VS Code flavor shares the log; an event this recent means its clock may be running.
const OTHER_WINDOW_ALIVE_MS = 150_000;
const AGENT_PROGRESS_MS = 60_000;

export function idleMs(): number {
  return vscode.workspace.getConfiguration('agentWorkbench').get<number>('time.idleMinutes', 5) * 60_000;
}

// Turns VS Code and agent activity into time events. Strict: only things you do count as your time.
// "Focus" is the session you last did something in; activity elsewhere or leaving the window ends it.
export class TimeTracker implements vscode.Disposable {
  private focused?: Session;
  private readonly lastActivity = new Map<string, number>();
  private readonly lastAgentProgress = new Map<string, number>();
  private readonly terminals = new Map<vscode.Terminal, string>();
  private readonly listeners: vscode.Disposable[];
  private todayCache?: { day: string; totals: Record<string, Totals> };
  private eventsCache?: { day: string; events: TimeEvent[] };
  private readonly beatTimer: NodeJS.Timeout;
  // The work-item clock: which tickets are on it and which one your attention is on.
  readonly clock: ClockTracker;

  constructor(
    private readonly logDir: string,
    private readonly sessions: () => Session[],
    private readonly onChange: () => void,
  ) {
    this.clock = new ClockTracker(
      {
        now: () => Date.now(),
        emit: (type, ticket, at) => this.write({ ts: new Date(at).toISOString(), ticket, session: 'clock', type }),
        after: (ms, fn) => {
          const handle = setTimeout(fn, ms);
          return () => clearTimeout(handle);
        },
      },
      () => this.onChange(),
    );
    this.beatTimer = setInterval(() => this.clock.beat(), BEAT_MS);
    const fromEditor = (e: { document: vscode.TextDocument } | undefined) => this.touch(this.sessionForDocument(e?.document));
    this.listeners = [
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) {
          this.touch(undefined);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(fromEditor),
      vscode.window.onDidChangeTextEditorSelection((e) => fromEditor(e.textEditor)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => fromEditor(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length > 0) {
          fromEditor({ document: e.document });
        }
      }),
      vscode.window.onDidChangeActiveTerminal((t) => this.touch(t ? this.sessionById(this.terminals.get(t)) : undefined)),
      vscode.window.onDidStartTerminalShellExecution((e) => {
        const session = this.sessionById(this.terminals.get(e.terminal));
        if (session) {
          this.touch(session); // you ran a command in the session's shell
        }
      }),
      vscode.window.onDidCloseTerminal((t) => this.terminals.delete(t)),
    ];
  }

  // Call once everything that onChange touches exists. A clock left open by a crash or restart closes at the
  // last recorded event, unless that event is so recent that another window is probably still running it.
  start(): void {
    const { events } = readEvents(this.logDir, localDays(new Date(), new Date())[0]);
    const last = events.length > 0 ? Date.parse(events[events.length - 1].ts) : 0;
    if (last > 0 && Date.now() - last > OTHER_WINDOW_ALIVE_MS) {
      this.clock.reset();
    }
  }

  registerTerminal(terminal: vscode.Terminal, session: Session): void {
    this.terminals.set(terminal, session.id);
  }

  // The session you last did something in, if you are still in it.
  get focusedSession(): Session | undefined {
    return this.focused;
  }

  sessionStarted(session: Session): void {
    this.emit(session, 'session-start');
  }

  sessionEnded(session: Session): void {
    if (this.focused?.id === session.id) {
      this.focused = undefined;
    }
    this.emit(session, 'session-end');
  }

  statusChanged(session: Session, prev: AgentStatus | undefined, next: AgentStatus | undefined): void {
    for (const type of eventsForStatusChange(prev?.state, next?.state)) {
      if (type === 'activity') {
        // You submitted a prompt or answered the agent: activity in that session, if you are here at all.
        if (vscode.window.state.focused) {
          this.touch(session);
        }
      } else {
        this.emit(session, type);
      }
    }
    // Still working, with fresh hook activity: record progress so a crash loses at most a minute.
    if (prev?.state === 'working' && next?.state === 'working' && prev.at !== next.at) {
      const last = this.lastAgentProgress.get(session.id) ?? 0;
      if (Date.now() - last >= AGENT_PROGRESS_MS) {
        this.lastAgentProgress.set(session.id, Date.now());
        this.emit(session, 'agent-working');
      }
    }
  }

  adjust(session: Session, minutes: number, note: string): void {
    this.emit(session, 'adjust', { minutes, ...(note ? { note } : {}) });
  }

  // A correction on a ticket that has no session (e.g. from the ticket hub before any work started).
  adjustTicket(key: string, minutes: number, note: string): void {
    this.write({ ts: new Date().toISOString(), ticket: key, session: `adjust:${key}`, type: 'adjust', minutes, ...(note ? { note } : {}) });
    this.onChange();
  }

  // Today's totals per ticket key, recomputed after each new event. Open clock intervals run up to now.
  today(): Record<string, Totals> {
    const [day] = localDays(new Date(), new Date());
    if (this.todayCache?.day !== day.label) {
      this.todayCache = { day: day.label, totals: this.compute(day) };
    }
    return this.todayCache.totals;
  }

  // Same as today() but never cached, for the ticking status bar.
  liveToday(): Record<string, Totals> {
    return this.compute(localDays(new Date(), new Date())[0]);
  }

  private compute(day: { start: number; end: number }): Record<string, Totals> {
    return totalsByTicket(this.todayEvents(), day, { idleMs: idleMs(), asOf: Date.now() });
  }

  // The log read once per day and then kept in step with what this window appends.
  private todayEvents(): TimeEvent[] {
    const [day] = localDays(new Date(), new Date());
    if (this.eventsCache?.day !== day.label) {
      this.eventsCache = { day: day.label, events: readEvents(this.logDir, day).events };
    }
    return this.eventsCache.events;
  }

  private write(event: TimeEvent): void {
    appendEvent(this.logDir, event);
    this.eventsCache?.events.push(event);
    this.todayCache = undefined;
  }

  dispose(): void {
    clearInterval(this.beatTimer);
    this.touch(undefined);
    this.listeners.forEach((l) => l.dispose());
  }

  private touch(session: Session | undefined): void {
    // Cheap and called on every signal: lets the clock follow your attention between tickets.
    this.clock.focus(session ? ticketKey(session) : undefined);
    if (session?.id === this.focused?.id) {
      if (session) {
        const last = this.lastActivity.get(session.id) ?? 0;
        if (Date.now() - last >= HEARTBEAT_MS) {
          this.lastActivity.set(session.id, Date.now());
          this.emit(session, 'activity');
        }
      }
      return;
    }
    if (this.focused) {
      this.emit(this.focused, 'focus-end');
    }
    this.focused = session;
    if (session) {
      this.lastActivity.set(session.id, Date.now());
      this.emit(session, 'focus-start');
    }
  }

  private emit(session: Session, type: TimeEventType, extra: Partial<TimeEvent> = {}): void {
    this.write({ ts: new Date().toISOString(), ticket: ticketKey(session), session: session.id, type, ...extra });
    this.onChange();
  }

  private sessionForDocument(doc: vscode.TextDocument | undefined): Session | undefined {
    if (!doc || doc.uri.scheme !== 'file') {
      return undefined;
    }
    return sessionForPath(this.sessions(), doc.uri.fsPath, process.platform === 'win32');
  }

  private sessionById(id: string | undefined): Session | undefined {
    return id === undefined ? undefined : this.sessions().find((s) => s.id === id);
  }
}
