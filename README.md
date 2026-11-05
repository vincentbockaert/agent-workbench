# Agent Workbench

A VS Code control room for agentic coding, with **tickets as the root of the work**:

- Tickets from any tracker (GitHub, GitLab, Jira, Trello, …) are imported **read-only**; the workbench never changes a ticket.
- "Work on this" creates an isolated **git worktree + branch** per session and starts an agent (Claude Code, Codex, or any CLI agent you configure). Your own working tree and open files are never touched.
- Sessions run in parallel and **signal when they need you**: orange bell, view badge, status bar, notification.
- Each session shows its **changed files** with side-by-side diffs against where it started, and can be resumed, finished or deleted.
- Every ticket has a local **workbench status** (To do → Doing → Review → Done), next to the tracker's read-only status.
- Time on tickets is tracked **deterministically** from an append-only event log: your time, agent time and elapsed time, with a weekly report to enter into your timesheet.

Not published to a marketplace: releases are `.vsix` files on this repository's [GitHub Releases page](https://github.com/vincentbockaert/agent-workbench/releases).

## Install

From a release: download `agent-workbench-<version>.vsix` from the Releases page, then
`code --install-extension agent-workbench-<version>.vsix` (`code-insiders` for VS Code Insiders), or use *Extensions: Install from VSIX…*.

From source:

```bash
npm install
npm run package
code --install-extension agent-workbench-0.0.1.vsix   # use code-insiders for VS Code Insiders
```

Or open this folder in VS Code and press F5 to run it in a development window.

Requirements: Git, Node.js on `PATH` (agent hooks call `bin/wb.js` with `node`), and the CLIs of your tracker and agents.

## Quick start

1. Open a git repository, **or a folder that contains several repositories**, in VS Code and click the **Agent Workbench** icon in the activity bar.
2. Add a ticket source to your settings (`agentWorkbench.ticketSources`), for example GitHub via `gh`, then click **Refresh**.
3. Click ＋ on a ticket ("Work on this in new session"), pick an agent, and watch the session appear under the ticket.
4. Click a ticket to open its **ticket tab**; click the clock for the **time report**.

## Several repositories in one window

Open a parent folder (say `~/repos/harm`) and the workbench works with every repository directly inside it, regardless of where VS Code was started:

- A folder that is itself a repo counts as one repo. Otherwise its direct subfolders with a `.git` folder are the repos (one level deep). Session worktrees (`<repo>.worktrees/…`) are never mistaken for repos.
- Each ticket source runs in **each repo** and shows up as its own group, named `<source> · <repo>` (for example `GitHub · billing`), so ticket numbers of different repos never collide. With a single repo the names stay plain.
- "Work on this" creates the session in that ticket's repo. Ad-hoc sessions and tickets of a workspace source ask which repo.
- Repos are looked up again when you add or remove a workspace folder and when you click **Refresh**.
- Sessions of repos outside the window are kept but hidden until you open them.

Sources not tied to a repo (Jira, Trello) would return the same tickets once per repo, so mark them `"scope": "workspace"`: they run once, in the window's root folder. The default is `"scope": "repo"`.

## Ticket sources

A source is configuration, not code: a shell command that prints JSON, plus a map from ticket fields to dotted paths in each item. The command runs in the repo (or, with `"scope": "workspace"`, in your workspace folder) and uses the CLI's own login.

```json
"agentWorkbench.ticketSources": [
  {
    "name": "GitHub",
    "listCmd": "gh issue list --state open --limit 100 --json number,title,state,url,body",
    "map": { "id": "number", "title": "title", "status": "state", "url": "url", "description": "body" }
  }
]
```

- `scope` is `"repo"` (default, runs in each repo) or `"workspace"` (runs once in the window's root folder); see [Several repositories](#several-repositories-in-one-window).
- `map.id` and `map.title` are required; `status`, `url` and `description` are optional.
- `itemsPath` points at the array when the command prints an object (e.g. Jira's `"issues"`).
- Refreshing saves a snapshot; the view always renders from snapshots, so it works offline.

Ready-made examples, each tested against sample output, are in `src/tickets/examples` in this repository (copy one into your settings):

| File | Needs | Notes |
|---|---|---|
| `github.json` | `gh` (logged in) | Verified against real `gh` output. |
| `gitlab.json` | `glab` (logged in) | Uses `glab issue list --output json`; the id is the project-level `iid`. |
| `jira-acli.json` | Atlassian CLI `acli` (logged in) | Assumes `--json` prints Jira's REST issue shape (`key`, `fields.summary`, `fields.status.name`); check your acli version's output. |
| `jira-rest.json` | `curl`, env `JIRA_EMAIL`, `JIRA_API_TOKEN` | Replace `YOUR-SITE`. Jira descriptions are rich-text objects, so none is mapped. |
| `trello.json` | `curl`, env `TRELLO_KEY`, `TRELLO_TOKEN` | Replace `YOUR-LIST-ID`. Trello has no status field. |

**Windows:** commands run in `cmd.exe`, so the `curl` examples' `$JIRA_EMAIL` style variables must be written `%JIRA_EMAIL%` there. These variables are your own settings; no ticket text is ever put into a command.

## Agents

Built in: `claude` (Claude Code) and `codex`. Add or override profiles in `agentWorkbench.agents`:

```json
"agentWorkbench.agents": [
  { "id": "aider", "label": "Aider", "startCmd": "aider --message-file ${promptFile}" }
]
```

Placeholders: `${promptFile}` (the relative path `.workbench/TASK.md`), `${sessionId}`, `${branch}`. Commands run in the session's worktree, so "continue the latest conversation here" (`claude --continue`) resumes exactly that session.

`agentWorkbench.defaultAgent` picks the preselected agent; with `agentWorkbench.startAgentOnCreate` off, "No agent — just the worktree" is preselected.

### "Needs your input" signals

Agents report their state through `bin/wb.js`, which writes `.workbench/status.json` in the session (from `$WB_STATUS_FILE`, set in each session terminal):

- **Claude Code:** set up automatically. Opening an agent writes hooks into the worktree's `.claude/settings.local.json` (git-excluded).
- **Codex:** add once to `~/.codex/config.toml`: `notify = ["node", "<extension folder>/bin/wb.js", "hook", "codex"]`. Codex reports finished turns only, not approval prompts.
- **Anything else:** call `node <extension folder>/bin/wb.js status needs-input "message"` (states: `working`, `needs-input`, `done`, `exited`).
- Without hooks, the terminal's start and end still give "working" and "stopped".

Outside a workbench session `wb.js` does nothing, so global hooks are harmless.

## Sessions

- **Work on this** (ticket) or **New ad-hoc session** creates `wb/<source>-<id>-<n>` in `<repo>.worktrees/<…>` next to your repository, writes `.workbench/TASK.md` from the ticket, and starts the chosen agent.
- **Open Agent** focuses the agent terminal, resumes the last agent, or starts the default one. **Open Shell** opens a terminal in the worktree.
- Expand a session to see its **changed files**; click one for a diff against the commit the session started from.
- **Create Pull Request** types `git push … && gh pr create …` into a terminal for you to review; it never runs it for you.
- **Finish Session** removes the worktree and keeps the branch; it refuses while there are uncommitted changes. **Delete Session** can discard them after asking.

## Manual work on a ticket

A ticket lists, next to its sessions, **every local branch whose name carries the ticket key**, in every repo found in the window: `feature/PROJ-1938-env-traffic`, `proj-1938`, `feat/PROJ-1938_x` all belong to `PROJ-1938`. Work you started by hand, in a plain branch or in your own worktree, shows up without any setup.

- Matching is case-insensitive and delimited by non-alphanumerics, so `PROJ-19` never matches `proj-1938`. Only Jira-style ids (`ABC-123`) are matched by name; tickets with numeric ids (GitHub `#12`) show their sessions only.
- Expand a branch to see its changes against the merge base with the repo's default branch (`origin/HEAD`, else `main` or `master`); click a file for the same side-by-side diff as for sessions.
- **Checked out** (in a worktree or the main working tree): the diff includes uncommitted and untracked work, and its right side is the real file, so you can edit it right there.
- **No checkout**: only committed changes, shown read-only. **Open in New Worktree** (inline button or context menu) checks the branch out into `<repo>.worktrees/<branch>` without starting an agent; the branch then behaves like the case above.
- Branches and worktrees are read once per **Refresh** (and at start-up), not on every click. A branch or worktree you create outside the workbench appears after the next Refresh.
- Parallel work is not tied to how it was started: a session, a worktree you made yourself, or a plain branch all end up under the ticket.

## Workbench status

To do → Doing → Review → Done, stored locally per ticket. It moves on its own where the signal is unambiguous:

- starting a session: **Doing**
- Create Pull Request: **Review** (never reopens Done)
- the ticket's last session finished or deleted: asks whether to mark it **Done**

Change it any time from the ticket's context menu or the ticket tab. The tracker's status is shown next to it, read-only, as of the last refresh. The filter matches both; **Hide Done Tickets** is in the view's `…` menu.

## Time tracking

All time comes from an append-only log (`timelog/YYYY-MM.jsonl`); totals are recomputed from it, so the same log always gives the same numbers.

- **Agent time:** from "working" until the agent waits, finishes or exits.
- **Your time (strict):** only while you do something in a session (edit, select or scroll in its files, switch to its terminal, run a command in its shell, submit or answer a prompt). A gap longer than `agentWorkbench.time.idleMinutes` (5) ends the interval at your last activity.
- **Elapsed:** you or an agent; parallel sessions on one ticket count once.
- Intervals left open (e.g. a crash) close at the last recorded event, never "now".
- **Adjust Time…** adds corrections (e.g. a call) as new events; nothing is ever edited.

`agentWorkbench.time.bookedFigure` chooses what is booked (elapsed, your or agent time); `agentWorkbench.time.roundToMinutes` rounds it up per ticket per day in reports only.

### Time report

The clock opens the **Time Report** tab: pick a period, the booked figure and rounding; **Copy as CSV** for your timesheet. After you enter time in your tracker or timesheet yourself, **Mark as entered…** records that locally, so the report shows what is still open (and how much more, if you kept working after entering it).

## Where things are stored

In VS Code's global storage for the extension (`…/globalStorage/local.agent-workbench/`):

| File | Contents |
|---|---|
| `sessions.json` | Sessions (repo, worktree, branch, ticket, agent) |
| `tickets/<source>.json` | Ticket snapshots from the last refresh |
| `ticket-status.json` | Workbench status per ticket |
| `timelog/YYYY-MM.jsonl` | Time events (append-only) |
| `entered.jsonl` | What you marked as entered (append-only) |

Per session, in its worktree (git-excluded): `.workbench/TASK.md`, `.workbench/status.json`, and for Claude `.claude/settings.local.json`.

## Releasing

1. Bump `version` in `package.json` (`npm version <patch|minor> --no-git-tag-version`), commit and merge to `main`.
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. The `Release` workflow checks that the tag matches `package.json`, runs typecheck and unit tests, builds the `.vsix` and attaches it to a GitHub Release with generated notes.

CI (`ci.yml`) runs typecheck, unit tests and packaging on every push to `main` and every pull request. Integration tests (`npm run test:vscode`) need a display and run locally.

## Development

```bash
npm run build        # bundle to dist/
npm run typecheck
npm test             # unit tests (fast, real git in temp folders)
npm run test:vscode  # integration tests in a real VS Code instance
npm run package      # build the .vsix
```

## Known limits

- Your time cannot see typing inside an agent's terminal; it counts from submitting or answering a prompt.
- Codex has no approval hook, so it never shows "needs input".
- Ticket tabs and the time report redraw fully when their numbers change, which resets scrolling.
- "Mark as entered" cannot be undone from the UI yet.

## License

[Apache License 2.0](LICENSE). The shipped extension bundles no third-party code; the npm packages in `package-lock.json` are build and test tools only, and are not redistributed.
