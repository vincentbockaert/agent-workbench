import { formatDuration } from '../time/report';
import { HubModel, HubSession } from './model';

// Messages the page posts back; the panel maps them onto existing commands.
export type HubMessage =
  | { command: 'newSession' }
  | { command: 'openInBrowser' }
  | { command: 'adjustTime' }
  | { command: 'openAgent'; session: string }
  | { command: 'openShell'; session: string }
  | { command: 'openTask'; session: string };

const SESSION_COMMANDS = ['openAgent', 'openShell', 'openTask'];
const TICKET_COMMANDS = ['newSession', 'openInBrowser', 'adjustTime'];

function esc(s: string | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STATE: Record<NonNullable<HubSession['state']>, { label: string; color: string }> = {
  'needs-input': { label: 'Needs input', color: 'var(--vscode-charts-orange)' },
  working: { label: 'Working', color: 'var(--vscode-charts-blue)' },
  done: { label: 'Your move', color: 'var(--vscode-charts-green)' },
  exited: { label: 'Stopped', color: 'var(--vscode-descriptionForeground)' },
};

function sessionRow(s: HubSession): string {
  const state = s.state ? STATE[s.state] : { label: 'Not started', color: 'var(--vscode-descriptionForeground)' };
  const primary = s.state === 'needs-input' ? 'Answer' : 'Open Agent';
  const changes = s.files > 0 ? `${s.files} file${s.files === 1 ? '' : 's'} <span class="add">+${s.added}</span> <span class="del">−${s.removed}</span>` : '<span class="muted">no changes</span>';
  return `<tr${s.state === 'needs-input' ? ' class="attention"' : ''}>
  <td><span class="state" style="color:${state.color}">● ${esc(state.label)}</span>${s.since ? ` <span class="muted">· ${esc(s.since)}</span>` : ''}</td>
  <td>${esc(s.agent) || '<span class="muted">—</span>'}</td>
  <td class="mono">${esc(s.branch)}</td>
  <td>${changes}</td>
  <td class="muted">${esc(s.message)}</td>
  <td class="actions">
    <button class="${s.state === 'needs-input' ? 'primary' : ''}" data-command="openAgent" data-session="${esc(s.id)}">${primary}</button>
    <button data-command="openShell" data-session="${esc(s.id)}">Shell</button>
    <button data-command="openTask" data-session="${esc(s.id)}">Task</button>
  </td>
</tr>`;
}

// The whole webview HTML. All tracker text is escaped: it is untrusted input.
// Styles follow the VS Code theme through its CSS variables; scripts only run with the nonce.
export function renderTicketHub(model: HubModel, nonce: string, cspSource: string): string {
  const { ticket, sessions, week, days, timeline } = model;
  const maxDay = Math.max(1, ...days.map((d) => d.elapsedMs));
  const bars = days
    .map((d) => {
      const h = d.elapsedMs > 0 ? Math.max(4, Math.round((d.elapsedMs / maxDay) * 80)) : 2;
      return `<div class="day${d.isToday ? ' today' : ''}"><span class="muted small">${d.elapsedMs > 0 ? formatDuration(d.elapsedMs) : ''}</span><span class="bar" style="height:${h}px"></span><span class="small">${esc(d.label)}${d.isToday ? ' · today' : ''}</span></div>`;
    })
    .join('');
  const spans = (ivs: [number, number][], cls: string) =>
    ivs.map(([a, b]) => `<span class="${cls}" style="left:${(a * 100).toFixed(2)}%;width:${Math.max(0.3, (b - a) * 100).toFixed(2)}%"></span>`).join('');
  const hours = timeline.hours.map((h) => `<span style="left:${(h.at * 100).toFixed(2)}%">${esc(h.label)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ticket.id)}</title>
<style>
body{margin:0;padding:28px 32px 48px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:13px}
main{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
h1{margin:0;font-size:24px;font-weight:600}
h2{margin:0 0 10px;font-size:11px;letter-spacing:.06em;font-weight:600;color:var(--vscode-descriptionForeground)}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:11px}.mono{font-family:var(--vscode-editor-font-family);font-size:12px}
.meta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12px;color:var(--vscode-descriptionForeground)}
.pill{padding:2px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
header{display:flex;flex-wrap:wrap;gap:16px 24px;align-items:flex-start}
header .text{flex:999 1 480px;min-width:0;display:flex;flex-direction:column;gap:10px}
header .buttons{flex:1 1 240px;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
p.desc{margin:0;max-width:720px;line-height:1.55;white-space:pre-wrap}
button{font:inherit;min-height:28px;padding:0 12px;border-radius:2px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.5;cursor:default}
.table{overflow-x:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}
table{width:100%;min-width:820px;border-collapse:collapse}
th{text-align:left;font-weight:500;font-size:12px;color:var(--vscode-descriptionForeground);padding:9px 12px;background:var(--vscode-sideBar-background)}
td{padding:9px 12px;border-top:1px solid var(--vscode-panel-border)}
tr.attention td{background:color-mix(in srgb,var(--vscode-charts-orange) 9%,transparent)}
td.actions{text-align:right;white-space:nowrap}td.actions button{margin-left:6px}
.add{color:var(--vscode-gitDecoration-addedResourceForeground)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.row{display:flex;flex-wrap:wrap;gap:24px}.row>section{flex:1 1 340px;min-width:0}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.card b{font-size:20px;font-weight:600}
.days{height:130px;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:12px 16px 8px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;align-items:end}
.day{display:flex;flex-direction:column;align-items:center;gap:6px}.bar{width:100%;border-radius:3px 3px 0 0;background:var(--vscode-descriptionForeground);opacity:.55}
.day.today .bar{opacity:1;background:var(--vscode-foreground)}
.lanes{display:grid;grid-template-columns:56px minmax(0,1fr);gap:6px 10px;align-items:center;font-size:12px}
.lane{position:relative;height:14px;border-radius:3px;background:var(--vscode-input-background)}
.lane span{position:absolute;top:0;bottom:0;border-radius:3px}
.you{background:var(--vscode-charts-blue)}.agents{background:var(--vscode-charts-purple)}
.axis{position:relative;height:14px;font-size:11px;color:var(--vscode-descriptionForeground)}.axis span{position:absolute;transform:translateX(-50%)}
</style>
</head>
<body>
<main>
<header>
  <div class="text">
    <div class="meta"><span class="mono">${esc(ticket.source)} · ${esc(ticket.id)}</span>${ticket.status ? `<span class="pill">${esc(ticket.status)}</span>` : ''}${ticket.listed ? '' : '<span>not in the tracker list anymore</span>'}</div>
    <h1>${esc(ticket.title)}</h1>
    ${ticket.description ? `<p class="desc">${esc(ticket.description)}</p>` : ''}
  </div>
  <div class="buttons">
    ${ticket.url ? '<button data-command="openInBrowser">Open in tracker</button>' : ''}
    <button data-command="adjustTime">Adjust time…</button>
    <button class="primary" data-command="newSession"${ticket.listed ? '' : ' disabled title="Refresh tickets: this ticket is no longer listed"'}>Work on this in new session</button>
  </div>
</header>

<section>
  <h2>SESSIONS · ${sessions.length}</h2>
  ${
    sessions.length === 0
      ? '<p class="muted">No sessions yet. “Work on this in new session” creates a worktree and starts an agent.</p>'
      : `<div class="table"><table><thead><tr><th>State</th><th>Agent</th><th>Branch</th><th>Changes</th><th>Last message</th><th></th></tr></thead><tbody>${sessions.map(sessionRow).join('')}</tbody></table></div>`
  }
</section>

<div class="row">
  <section>
    <h2>THIS WEEK ON THIS TICKET</h2>
    <div class="cards">
      <div class="card"><span class="muted">Elapsed</span><b>${formatDuration(week.elapsedMs)}</b><span class="muted small">${formatDuration(week.bookedMs)} booked</span></div>
      <div class="card"><span class="muted">You</span><b style="color:var(--vscode-charts-blue)">${formatDuration(week.yourMs)}</b><span class="muted small">incl. adjustments</span></div>
      <div class="card"><span class="muted">Agents</span><b style="color:var(--vscode-charts-purple)">${formatDuration(week.agentMs)}</b><span class="muted small">overlaps counted once</span></div>
    </div>
  </section>
  <section>
    <h2>ELAPSED PER DAY</h2>
    <div class="days" role="img" aria-label="Elapsed time per day this week">${bars}</div>
  </section>
</div>

<section>
  <h2>TODAY'S TIMELINE</h2>
  <div class="lanes">
    <span class="muted">You</span><div class="lane">${spans(timeline.you, 'you')}</div>
    <span class="muted">Agents</span><div class="lane">${spans(timeline.agents, 'agents')}</div>
    <span></span><div class="axis">${hours}</div>
  </div>
</section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const b of document.querySelectorAll('button[data-command]')) {
  b.addEventListener('click', () => vscode.postMessage({ command: b.dataset.command, session: b.dataset.session }));
}
</script>
</body>
</html>`;
}

// Only known commands with the fields they need; anything else from the page is ignored.
export function parseHubMessage(msg: unknown): HubMessage | undefined {
  if (msg === null || typeof msg !== 'object') {
    return undefined;
  }
  const { command, session } = msg as { command?: unknown; session?: unknown };
  if (typeof command !== 'string') {
    return undefined;
  }
  if (TICKET_COMMANDS.includes(command)) {
    return { command } as HubMessage;
  }
  if (SESSION_COMMANDS.includes(command) && typeof session === 'string' && session !== '') {
    return { command, session } as HubMessage;
  }
  return undefined;
}
