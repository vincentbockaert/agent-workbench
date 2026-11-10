import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { agentChoices, lastOptions } from './agents/choices';
import { defaultOptionsFor, pickAgentOptions } from './agents/optionsPick';
import { agentCommand, AgentOptions, supportsOptions } from './agents/profiles';
import { agentProfiles, AgentTerminals } from './agents/terminals';
import { WORK_VIEW_ID } from './constants';
import { HubTicket } from './hub/model';
import { TicketHubs } from './hub/panel';
import { TimeReportPanel } from './report/panel';
import { deleteSession, hasOtherTicketSessions, nextSessionId, startSession, WORKBENCH_DIR } from './sessions/lifecycle';
import { Session, sessionsInRepos, sessionSlugBase } from './sessions/model';
import { SessionStore } from './sessions/store';
import { readSnapshot, refreshAll } from './tickets/snapshot';
import { candidateRepos, expandSources } from './tickets/expand';
import { BaseMode, describeBase, listBaseChoices, resolveBase } from './git/basebranch';
import { discoverRepos, RepoInfo } from './git/repos';
import { isStale, readPrSnapshot, refreshTicketPrs } from './pr/cache';
import { prTargets } from './pr/targets';
import { addWorktreeForBranch, worktreeRootFor } from './git/worktree';
import { WorkIndex } from './tickets/workIndex';
import { Ticket, TicketSourceConfig } from './tickets/source';
import { displayedMs, promptAdjustment } from './time/commands';
import { clockMark, shortLabel } from './time/clockbar';
import { formatDuration } from './time/report';
import { ticketKey, ticketKeyOf } from './time/rules';
import { TimeTracker } from './time/tracker';
import { statusAfter, WORK_LABELS, WORK_STATUSES, WorkEvent, WorkflowStore } from './tickets/workflow';
import { openBranchChange, openChange, registerChangeProviders, sessionForEditor } from './ui/changes';
import { askInstructions, startWithInstructions, START_AGENT_COMMAND } from './ui/instructions';
import { ClockStatus, TIMER_MENU_COMMAND } from './ui/clockstatus';
import { StatusSignals } from './ui/signals';
import { WorkNode, WorkTreeProvider } from './ui/tree';

function ticketSources(): TicketSourceConfig[] {
  return vscode.workspace.getConfiguration('agentWorkbench').get<TicketSourceConfig[]>('ticketSources', []);
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

// Ticket commands such as `gh issue list` depend on the current repo, so run them in the workspace.
function commandCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const snapshotDir = path.join(context.globalStorageUri.fsPath, 'tickets');
  const store = new SessionStore(path.join(context.globalStorageUri.fsPath, 'sessions.json'));
  if (store.warning) {
    void vscode.window.showWarningMessage(`Agent Workbench: ${store.warning}`);
  }
  // Repos found in the workspace folders (a folder that is a repo, or the repos directly inside it).
  let repos: RepoInfo[] = await discoverRepos(workspacePaths());
  // Configured sources resolved per repo / workspace; their (effective) names key snapshots and tickets.
  const effectiveSources = () => expandSources(ticketSources(), repos, commandCwd());
  const sessionsHere = () => sessionsInRepos(store.list(), repos);
  // Read per use, so a changed setting applies to the next session; existing sessions keep their folder.
  const worktreeRootOf = (repo: string): string =>
    worktreeRootFor(repo, vscode.workspace.getConfiguration('agentWorkbench').get<string>('worktreesFolder', ''), os.homedir());
  // Looks again for repos (a folder was added, or a repo was cloned into the parent folder).
  const rediscover = async (): Promise<void> => {
    repos = await discoverRepos(workspacePaths());
    changed();
    void workIndex.ensure().then(() => tree.refresh());
  };
  // The workbench's own ticket status; trackers are only ever read.
  const workflow = new WorkflowStore(path.join(context.globalStorageUri.fsPath, 'ticket-status.json'));
  if (workflow.warning) {
    void vscode.window.showWarningMessage(`Agent Workbench: ${workflow.warning}`);
  }
  const advance = (session: Session, event: WorkEvent): void => {
    if (session.ticket) {
      const key = ticketKey(session);
      const next = statusAfter(workflow.get(key), event);
      if (next) {
        workflow.set(key, next);
      }
    }
  };
  // Branches and worktrees of every repo, read once per refresh so tickets can list their manual work.
  const workIndex = new WorkIndex(() => repos);
  const tree = new WorkTreeProvider(() => effectiveSources().map((s) => s.cfg), snapshotDir, sessionsHere, (id) => signals.get(id), () => tracker.today(), (key) => workflow.get(key), workIndex, () => tracker.clock.state(), () => tracker.liveToday());
  void workIndex.ensure().then(() => tree.refresh());
  const view = vscode.window.createTreeView(WORK_VIEW_ID, { treeDataProvider: tree });
  const logDir = path.join(context.globalStorageUri.fsPath, 'timelog');
  const focusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  focusBar.command = 'agentWorkbench.timeReport';
  // The ticket you are working in and its time today, e.g. "PROJ-123 · 3h 05m today".
  const updateFocusBar = (): void => {
    const s = tracker.focusedSession;
    if (!s) {
      focusBar.hide();
      return;
    }
    focusBar.text = `$(clock) ${s.ticket ? s.ticket.id : s.title ?? s.id} · ${formatDuration(displayedMs(tracker.today()[ticketKey(s)]))} today`;
    focusBar.tooltip = 'Time booked today on the ticket you are working in. Click for the time report.';
    focusBar.show();
  };
  let clockStatus: ClockStatus | undefined;
  const tracker = new TimeTracker(logDir, sessionsHere, () => {
    tree.refresh();
    updateFocusBar();
    report.refresh();
    clockStatus?.refresh();
  });
  // Ticket titles for the report: from every session (all repos) and the listed tickets.
  const reportTitles = (): Record<string, string> => {
    const titles: Record<string, string> = {};
    for (const s of store.list()) {
      titles[ticketKey(s)] = s.ticket?.title ?? s.title ?? s.id;
    }
    for (const { cfg } of effectiveSources()) {
      for (const t of readSnapshot(snapshotDir, cfg.name)?.tickets ?? []) {
        titles[ticketKeyOf(t.source, t.id)] = t.title;
      }
    }
    return titles;
  };
  const report = new TimeReportPanel({
    logDir,
    enteredFile: path.join(context.globalStorageUri.fsPath, 'entered.jsonl'),
    titles: reportTitles,
  });
  clockStatus = new ClockStatus(tracker.clock, () => tracker.liveToday(), reportTitles);
  tracker.start();
  const signals = new StatusSignals(sessionsHere, view, () => tree.refresh(), (s, prev, next) => tracker.statusChanged(s, prev, next));
  // Sessions added or removed: re-sync status watchers, then redraw.
  const changed = (): void => {
    signals.sync();
    tree.refresh();
  };
  const agents = new AgentTerminals(store, context.asAbsolutePath('bin/wb.js'), changed, (t, s) => {
    tracker.registerTerminal(t, s);
    signals.expectActivity(s.id);
  });
  signals.sync();

  // A listed ticket from the snapshots (needed to start a session), by "<source>:<id>".
  const snapshotTicket = (key: string): Ticket | undefined => {
    for (const { cfg } of effectiveSources()) {
      const t = readSnapshot(snapshotDir, cfg.name)?.tickets.find((t) => ticketKeyOf(t.source, t.id) === key);
      if (t) {
        return t;
      }
    }
    return undefined;
  };
  // What the hub shows: the listed ticket, else what its sessions remember of it.
  const findTicket = (key: string): HubTicket | undefined => {
    const t = snapshotTicket(key);
    if (t) {
      return { key, source: t.source, id: t.id, title: t.title, status: t.status, url: t.url, description: t.description, listed: true, workStatus: workflow.get(key) };
    }
    const remembered = store.list().find((s) => s.ticket && ticketKeyOf(s.ticket.source, s.ticket.id) === key)?.ticket;
    return remembered && { key, source: remembered.source, id: remembered.id, title: remembered.title, url: remembered.url, listed: false, workStatus: workflow.get(key) };
  };
  const prDir = path.join(context.globalStorageUri.fsPath, 'prs');
  const prRefreshing = new Set<string>();
  const prSettings = () => {
    const c = vscode.workspace.getConfiguration('agentWorkbench');
    return { enabled: c.get<boolean>('pullRequests.enabled', true), maxAgeMs: c.get<number>('pullRequests.refreshMinutes', 5) * 60_000 };
  };
  // Asks GitHub (through gh) for the pull requests of one ticket and caches them; the open tab shows the cache.
  async function refreshPrs(key: string): Promise<void> {
    const ticket = findTicket(key);
    if (!ticket || !prSettings().enabled || prRefreshing.has(key)) {
      return;
    }
    prRefreshing.add(key);
    hubs.refreshAll();
    try {
      await refreshTicketPrs(key, ticket, prTargets(await workIndex.ensure(), ticket, store.list()), prDir, new Date());
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Workbench: could not refresh pull requests: ${(e as Error).message}`);
    } finally {
      prRefreshing.delete(key);
      hubs.refreshAll();
    }
  }
  const hubs = new TicketHubs({
    sessions: sessionsHere,
    status: (id) => signals.get(id),
    logDir,
    findTicket,
    pullRequests: (key) => ({ enabled: prSettings().enabled, snapshot: readPrSnapshot(prDir, key), refreshing: prRefreshing.has(key) }),
    clockMark: (key) => {
      const state = tracker.clock.state();
      if (!state.onClock.includes(key)) {
        return undefined;
      }
      const totals = tracker.liveToday();
      return clockMark(key, state, (k) => totals[k]?.timerMs ?? 0);
    },
    onOpen: (key) => {
      if (prSettings().enabled && isStale(readPrSnapshot(prDir, key), new Date(), prSettings().maxAgeMs)) {
        void refreshPrs(key);
      }
    },
    onMessage: (key, msg, session) => {
      switch (msg.command) {
        case 'setStatus':
          workflow.set(key, msg.status);
          return tree.refresh();
        case 'newSession': {
          const t = snapshotTicket(key);
          return t ? void newSession({ ticket: t }) : undefined;
        }
        case 'refreshPrs':
          return void refreshPrs(key);
        case 'openPr': {
          // The page only names a PR; the URL comes from our own cache, and only https is ever opened.
          const found = readPrSnapshot(prDir, key)?.prs.find((p) => `${p.repoRoot}#${p.number}` === msg.pr);
          return found?.url.startsWith('https://') ? void vscode.env.openExternal(vscode.Uri.parse(found.url)) : undefined;
        }
        case 'openInBrowser': {
          const url = findTicket(key)?.url;
          return url ? void vscode.env.openExternal(vscode.Uri.parse(url)) : undefined;
        }
        case 'adjustTime':
          return void promptAdjustment(findTicket(key)?.id ?? key).then((a) => a && tracker.adjustTicket(key, a.minutes, a.note));
        case 'openAgent':
          if (session) {
            clockOn(session);
          }
          return session ? void guarded(() => agents.open(session)) : undefined;
        case 'openShell':
          return session ? openShell(session) : undefined;
        case 'startTimer':
          return tracker.clock.start(key);
        case 'stopTimer':
          return tracker.clock.stop(key);
        case 'openTask':
          return session ? void vscode.commands.executeCommand('agentWorkbench.openSessionTask', { kind: 'session', session }) : undefined;
      }
    },
  });
  // Anything that redraws the tree may change what an open hub shows.
  tree.onDidChangeTreeData(() => hubs.refreshAll());

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
    const candidates = candidateRepos(opts.ticket?.source, effectiveSources(), repos);
    if (candidates.length === 0) {
      void vscode.window.showErrorMessage('Agent Workbench: open a git repository, or a folder containing git repositories, to start sessions.');
      return;
    }
    try {
      // The ticket's own repo; for tickets of a workspace source and ad-hoc sessions, ask when there are several.
      const chosen =
        candidates.length === 1
          ? candidates[0]
          : (await vscode.window.showQuickPick(
              candidates.map((r) => ({ label: r.name, description: r.root, repo: r })),
              { title: 'In which repository?', placeHolder: 'The session gets its own worktree and branch in this repository.' },
            ))?.repo;
      if (!chosen) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('agentWorkbench');
      // The base is chosen, never inferred from whatever the repo's own folder happens to have checked out.
      const decision = resolveBase(cfg.get<BaseMode>('baseBranch', 'ask'), await listBaseChoices(chosen.root));
      if ('error' in decision) {
        void vscode.window.showErrorMessage(`Agent Workbench: ${decision.error}`);
        return;
      }
      let baseRef: string;
      if ('ref' in decision) {
        baseRef = decision.ref;
      } else {
        const picked = await vscode.window.showQuickPick(
          decision.ask.map((choice) => {
            const d = describeBase(choice);
            return { label: `$(git-branch) ${d.label}`, description: d.description, detail: d.warning && `$(warning) ${d.warning}`, ref: choice.ref };
          }),
          {
            title: `Start ${opts.ticket ? `${opts.ticket.id} ${opts.ticket.title}` : opts.adhoc!.title} from which branch?`,
            placeHolder: 'The session gets its own branch and worktree, created from this one. Uncommitted work elsewhere is not included.',
            matchOnDescription: true,
          },
        );
        if (!picked) {
          return;
        }
        baseRef = picked.ref;
      }
      const repo = { root: chosen.root, branch: baseRef };
      // Show the agent choice with the branch and folder it will create, before creating anything.
      const worktreeRoot = worktreeRootOf(repo.root);
      const predicted = await nextSessionId(repo.root, sessionSlugBase(opts.ticket, opts.adhoc?.title), store, worktreeRoot);
      const lastUsed = opts.ticket
        ? store.list().filter((s) => s.ticket?.source === opts.ticket!.source && s.ticket.id === opts.ticket!.id && s.agent).pop()?.agent
        : undefined;
      const choices = agentChoices(agentProfiles().profiles, cfg.get<string>('defaultAgent', 'claude'), lastUsed, !cfg.get<boolean>('startAgentOnCreate', true));
      const picked = await vscode.window.showQuickPick(
        choices.map((choice) => ({
          label: choice.label,
          description: choice.description,
          detail: choice.profile
            ? agentCommand(choice.profile, 'start-bare', { sessionId: predicted, branch: `wb/${predicted}` }, {
                ...defaultOptionsFor(choice.profile),
                ...lastOptions(store.list(), opts.ticket ? { source: opts.ticket.source, id: opts.ticket.id } : undefined, choice.profile.id),
              })
            : 'Work on it yourself; time is still tracked on this ticket',
          choice,
        })),
        {
          title: `Work on ${opts.ticket ? `${opts.ticket.id} ${opts.ticket.title}` : opts.adhoc!.title} — branch wb/${predicted} from ${repo.branch}`,
          placeHolder: 'Which agent? Next you can write its first request. Your open files and working tree are not touched.',
          matchOnDetail: true,
        },
      );
      if (!picked) {
        return;
      }
      // With an agent: its model and effort, preselecting what this ticket used last, else your default.
      let agentOpts: AgentOptions | undefined;
      if (picked.choice.profile) {
        const ticketRef = opts.ticket ? { source: opts.ticket.source, id: opts.ticket.id } : undefined;
        agentOpts = await pickAgentOptions(picked.choice.profile, lastOptions(store.list(), ticketRef, picked.choice.profile.id), opts.ticket ? opts.ticket.id : opts.adhoc!.title);
        if (!agentOpts) {
          return;
        }
      }
      // With an agent: let the user write its first request. Empty or a closed tab starts it with no prompt.
      let instructions: string | undefined = '';
      if (picked.choice.profile) {
        instructions = await askInstructions(opts.ticket ? `${opts.ticket.id} ${opts.ticket.title}` : opts.adhoc!.title);
        if (instructions === undefined) {
          return; // an instructions tab for another session is still open
        }
      }
      const session = await startSession({ repo: repo.root, baseRef: repo.branch, store, instructions, worktreeRoot, ...opts });
      tracker.sessionStarted(session);
      clockOn(session);
      advance(session, 'session-started');
      changed();
      if (picked.choice.profile) {
        agents.startWith(session, picked.choice.profile, instructions !== '', agentOpts);
      } else {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(session.worktree, WORKBENCH_DIR, 'TASK.md')));
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Workbench: ${(e as Error).message}`);
    }
  }

  // Work on a session's ticket puts it on the clock (and makes it the active one).
  const clockOn = (session: Session): void => tracker.clock.start(ticketKey(session));
  const clockKeyOf = (node?: WorkNode): string | undefined =>
    node?.kind === 'ticket' ? ticketKeyOf(node.group.ticket.source, node.group.ticket.id) : node?.kind === 'session' ? ticketKey(node.session) : undefined;

  // Status bar click: stop or switch the timers that run, or start one on any ticket we know.
  async function timerMenu(): Promise<void> {
    const state = tracker.clock.state();
    const titles = reportTitles();
    const totals = tracker.liveToday();
    const label = (key: string) => shortLabel(key, titles);
    const spent = (key: string) => formatDuration(totals[key]?.timerMs ?? 0);
    const items: (vscode.QuickPickItem & { run: () => unknown })[] = [];
    for (const key of state.onClock) {
      if (key !== state.active) {
        items.push({ label: `$(play) Switch to ${label(key)}`, description: spent(key), detail: titles[key], run: () => tracker.clock.start(key) });
      }
      items.push({ label: `$(debug-stop) Stop ${label(key)}`, description: spent(key), detail: titles[key], run: () => tracker.clock.stop(key) });
    }
    if (state.onClock.length > 1) {
      items.push({ label: '$(debug-stop) Stop all', run: () => tracker.clock.stopAll() });
    }
    items.push({ label: '$(add) Start a timer on…', run: () => startTimerPicker(state.onClock) });
    const picked = await vscode.window.showQuickPick(items, { title: 'Timers', placeHolder: 'Stop or switch a timer, or start one' });
    await picked?.run();
  }

  async function startTimerPicker(skip: string[]): Promise<void> {
    const candidates = new Map<string, vscode.QuickPickItem & { key: string }>();
    for (const s of sessionsHere()) {
      const key = ticketKey(s);
      candidates.set(key, { key, label: s.ticket ? s.ticket.id : s.title ?? s.id, description: s.ticket?.title, detail: 'has a session' });
    }
    for (const { cfg } of effectiveSources()) {
      for (const t of readSnapshot(snapshotDir, cfg.name)?.tickets ?? []) {
        const key = ticketKeyOf(t.source, t.id);
        if (!candidates.has(key)) {
          candidates.set(key, { key, label: t.id, description: t.title, detail: [t.source, t.status].filter(Boolean).join(' · ') });
        }
      }
    }
    const items = [...candidates.values()].filter((c) => !skip.includes(c.key));
    const picked = await vscode.window.showQuickPick(items, { title: 'Start a timer on…', placeHolder: 'Ticket', matchOnDescription: true, matchOnDetail: true });
    if (picked) {
      tracker.clock.start(picked.key);
    }
  }

  // After a ticket's last session ends: offer to close it in the workbench (never in the tracker).
  async function offerDone(ended: Session): Promise<void> {
    if (!ended.ticket || hasOtherTicketSessions(store.list(), ended)) {
      return;
    }
    const key = ticketKey(ended);
    if (workflow.get(key) === 'done') {
      return;
    }
    const answer = await vscode.window.showInformationMessage(`That was the last session of ${ended.ticket.id}. Mark it Done in the workbench?`, 'Mark Done', 'Keep');
    if (answer === 'Mark Done') {
      workflow.set(key, 'done');
    }
  }

  function setHideDone(hide: boolean): void {
    tree.hideDone = hide;
    void vscode.commands.executeCommand('setContext', 'agentWorkbench.hideDone', hide);
    tree.refresh();
  }

  function setFilter(text: string): void {
    tree.filter = text.trim();
    view.description = tree.filter ? `filter: ${tree.filter}` : undefined;
    void vscode.commands.executeCommand('setContext', 'agentWorkbench.filtered', tree.filter !== '');
    tree.refresh();
  }

  // The session a command applies to: the tree node it was invoked on, else the active editor's session.
  function sessionOf(node: WorkNode | undefined): Session | undefined {
    if (node?.kind === 'session' || node?.kind === 'change') {
      return node.session;
    }
    return sessionForEditor(sessionsHere(), vscode.window.activeTextEditor);
  }

  function openShell(session: Session): void {
    clockOn(session);
    const terminal = vscode.window.createTerminal({ name: `wb: ${session.id}`, cwd: session.worktree });
    tracker.registerTerminal(terminal, session);
    terminal.show();
  }

  // Keeps "working · 4m" style durations and today's times moving while nothing else changes.
  const ticker = setInterval(() => {
    tree.refresh();
    updateFocusBar();
  }, 60_000);

  context.subscriptions.push(
    view,
    signals,
    tracker,
    focusBar,
    { dispose: () => clearInterval(ticker) },

    vscode.commands.registerCommand('agentWorkbench.filterTickets', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Show tickets whose id, title or status contains… (tickets with sessions always stay)',
        value: tree.filter,
        placeHolder: 'login, PROJ-12, in progress',
      });
      if (text !== undefined) {
        setFilter(text);
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.clearTicketFilter', () => setFilter('')),

    vscode.commands.registerCommand('agentWorkbench.setWorkStatus', async (node: WorkNode) => {
      if (node?.kind !== 'ticket') {
        return;
      }
      const key = ticketKeyOf(node.group.ticket.source, node.group.ticket.id);
      const current = workflow.get(key);
      const picked = await vscode.window.showQuickPick(
        WORK_STATUSES.map((st) => ({ label: WORK_LABELS[st], description: st === current ? 'current' : undefined, status: st })),
        { title: `Workbench status of ${node.group.ticket.id}`, placeHolder: 'Only changes the workbench; the tracker is never touched' },
      );
      if (picked) {
        workflow.set(key, picked.status);
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.hideDoneTickets', () => setHideDone(true)),
    vscode.commands.registerCommand('agentWorkbench.showDoneTickets', () => setHideDone(false)),

    hubs,

    vscode.commands.registerCommand('agentWorkbench.openTicketHub', (node: WorkNode) => {
      if (node?.kind === 'ticket') {
        hubs.open(ticketKeyOf(node.group.ticket.source, node.group.ticket.id));
      }
    }),

    report,
    vscode.commands.registerCommand('agentWorkbench.timeReport', () => report.open()),

    vscode.commands.registerCommand('agentWorkbench.startTimer', (node?: WorkNode) => {
      const key = clockKeyOf(node);
      if (key) {
        tracker.clock.start(key);
      }
    }),
    vscode.commands.registerCommand('agentWorkbench.stopTimer', (node?: WorkNode) => {
      const key = clockKeyOf(node);
      if (key) {
        tracker.clock.stop(key);
      }
    }),
    vscode.commands.registerCommand(TIMER_MENU_COMMAND, () => timerMenu()),

    vscode.commands.registerCommand('agentWorkbench.adjustTime', async (node: WorkNode) => {
      if (node?.kind === 'session') {
        const s = node.session;
        const adjustment = await promptAdjustment(s.ticket ? `${s.ticket.source} ${s.ticket.id}` : s.title ?? s.id);
        if (adjustment) {
          tracker.adjust(node.session, adjustment.minutes, adjustment.note);
        }
      }
    }),

    vscode.commands.registerCommand('agentWorkbench.refreshTickets', () =>
      vscode.window.withProgress({ location: { viewId: WORK_VIEW_ID } }, async () => {
        const now = new Date();
        repos = await discoverRepos(workspacePaths());
        workIndex.invalidate();
        await Promise.all([refreshAll(effectiveSources(), snapshotDir, now), workIndex.ensure()]);
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
      if (session) {
        clockOn(session);
      }
      return session ? guarded(() => agents.open(session)) : undefined;
    }),

    registerChangeProviders(),

    vscode.commands.registerCommand('agentWorkbench.openBranchChange', (node: WorkNode) =>
      node?.kind === 'branchChange' ? guarded(() => openBranchChange(node.target, node.file)) : undefined,
    ),

    // Checks a ticket's branch out into a new worktree (no agent) so its changes become editable.
    vscode.commands.registerCommand('agentWorkbench.openBranchWorktree', (node?: WorkNode) => {
      if (node?.kind !== 'branch' || node.branch.worktree) {
        return undefined;
      }
      const { repo, branch } = node.branch;
      return guarded(async () => {
        const dir = await addWorktreeForBranch(repo.root, branch, worktreeRootOf(repo.root));
        workIndex.invalidate(repo.root);
        await workIndex.ensure();
        tree.refresh();
        void vscode.window.showInformationMessage(`Checked out ${branch} in ${dir}. Expand it to edit the changes.`);
      });
    }),

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
      advance(session, 'pr-created');
      tree.refresh();
      void vscode.window.showInformationMessage(`Review the command in the "PR: ${session.id}" terminal and press Enter to push and open the pull request.`);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand('setContext', 'agentWorkbench.inSession', sessionForEditor(sessionsHere(), editor) !== undefined);
    }),

    vscode.commands.registerCommand('agentWorkbench.startAgent', (node: WorkNode) =>
      node?.kind === 'session' ? (clockOn(node.session), guarded(() => agents.start(node.session, true))) : undefined,
    ),

    // For the next start or resume in this session; a running agent keeps its model (use its own /model there).
    vscode.commands.registerCommand('agentWorkbench.changeAgentOptions', (node?: WorkNode) => {
      const session = sessionOf(node);
      if (!session) {
        return undefined;
      }
      return guarded(async () => {
        const current = store.list().find((s) => s.id === session.id) ?? session;
        const { profiles } = agentProfiles();
        const profile = profiles.find((p) => p.id === (current.agent ?? vscode.workspace.getConfiguration('agentWorkbench').get<string>('defaultAgent', 'claude')));
        if (!profile || !supportsOptions(profile)) {
          void vscode.window.showInformationMessage(`Agent Workbench: ${profile?.label ?? 'this agent'} takes no model or effort (see agentWorkbench.agents).`);
          return;
        }
        const picked = await pickAgentOptions(profile, { model: current.model, effort: current.effort }, current.title ?? current.id);
        if (!picked) {
          return;
        }
        store.update(session.id, { agent: profile.id, model: picked.model, effort: picked.effort });
        tree.refresh();
        const what = [picked.model, picked.effort].filter(Boolean).join(' · ') || "the agent's own defaults";
        void vscode.window.showInformationMessage(`${current.title ?? current.id}: ${profile.label} uses ${what} from the next start or resume. A running agent keeps its model; use its /model to switch now.`);
      });
    }),

    vscode.commands.registerCommand('agentWorkbench.resumeAgent', (node: WorkNode) =>
      node?.kind === 'session' ? (clockOn(node.session), guarded(() => agents.resume(node.session))) : undefined,
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
      if (!hasOtherTicketSessions(store.list(), s)) {
        tracker.clock.stop(ticketKey(s));
      }
      await offerDone(s);
      changed();
    }),

    // Finishing = the work is done and committed: refuses to throw away uncommitted changes (Delete can).
    vscode.commands.registerCommand('agentWorkbench.finishSession', async (node?: WorkNode) => {
      const s = sessionOf(node);
      if (!s) {
        return;
      }
      try {
        await deleteSession(store, s);
      } catch (e) {
        void vscode.window.showWarningMessage(`${s.id} has uncommitted changes. Commit them in the session first, or use Delete Session to discard them.`, {
          modal: true,
          detail: (e as Error).message,
        });
        return;
      }
      tracker.sessionEnded(s);
      if (!hasOtherTicketSessions(store.list(), s)) {
        tracker.clock.stop(ticketKey(s));
      }
      void vscode.window.showInformationMessage(`Finished ${s.id}: worktree removed, branch ${s.branch} kept.`);
      await offerDone(s);
      changed();
    }),

    vscode.commands.registerCommand(START_AGENT_COMMAND, () => startWithInstructions()),
    // Internal (used by the integration tests): the instructions tab on its own.
    vscode.commands.registerCommand('agentWorkbench.askInstructions', (label: string) => askInstructions(label)),

    vscode.workspace.onDidChangeWorkspaceFolders(() => void rediscover()),

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
