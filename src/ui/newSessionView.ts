export interface NewSessionRepoOption {
  root: string;
  name: string;
}

export interface NewSessionBranchOption {
  ref: string;
  label: string;
  description?: string;
  warning?: string;
}

export interface NewSessionAgentOption {
  id: string; // profile id, or 'none' for worktree-only
  label: string;
  description?: string;
  detail: string;
}

export interface NewSessionViewModel {
  heading: string;
  subtitle?: string;
  isAdhoc: boolean;
  repos: NewSessionRepoOption[];
  selectedRepo: string;
  branches: NewSessionBranchOption[];
  selectedBranch: string;
  agents: NewSessionAgentOption[];
  selectedAgent: string;
  predictedBranch: string;
  descriptionPlaceholder: string;
}

export interface NewSessionResult {
  repoRoot: string;
  baseRef: string;
  agentId: string; // 'none' or profile id
  instructions: string;
  withPrompt: boolean;
  adhocTitle?: string;
}

export type NewSessionMessage =
  | { command: 'repoChanged'; repoRoot: string }
  | { command: 'start'; repoRoot: string; baseRef: string; agentId: string; instructions: string; adhocTitle?: string }
  | { command: 'startBare'; repoRoot: string; baseRef: string; agentId: string; adhocTitle?: string }
  | { command: 'cancel' };

function esc(s: string | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function parseNewSessionMessage(raw: unknown): NewSessionMessage | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.command) {
    case 'cancel':
      return { command: 'cancel' };
    case 'repoChanged':
      return typeof m.repoRoot === 'string' && m.repoRoot !== '' ? { command: 'repoChanged', repoRoot: m.repoRoot } : undefined;
    case 'start':
      if (typeof m.repoRoot !== 'string' || typeof m.baseRef !== 'string' || typeof m.agentId !== 'string' || typeof m.instructions !== 'string') {
        return undefined;
      }
      return {
        command: 'start',
        repoRoot: m.repoRoot,
        baseRef: m.baseRef,
        agentId: m.agentId,
        instructions: m.instructions,
        ...(typeof m.adhocTitle === 'string' ? { adhocTitle: m.adhocTitle } : {}),
      };
    case 'startBare':
      if (typeof m.repoRoot !== 'string' || typeof m.baseRef !== 'string' || typeof m.agentId !== 'string') {
        return undefined;
      }
      return {
        command: 'startBare',
        repoRoot: m.repoRoot,
        baseRef: m.baseRef,
        agentId: m.agentId,
        ...(typeof m.adhocTitle === 'string' ? { adhocTitle: m.adhocTitle } : {}),
      };
    default:
      return undefined;
  }
}

export function renderNewSessionHtml(model: NewSessionViewModel, nonce: string, cspSource: string): string {
  const repoControl =
    model.repos.length > 1
      ? `<label class="field"><span>Repository</span><select id="repo">${model.repos
          .map((r) => `<option value="${esc(r.root)}"${r.root === model.selectedRepo ? ' selected' : ''}>${esc(r.name)}</option>`)
          .join('')}</select></label>`
      : `<div class="field"><span>Repository</span><div class="static mono">${esc(model.repos[0]?.name ?? '')}</div></div>`;

  const branchOptions = model.branches
    .map(
      (b) =>
        `<option value="${esc(b.ref)}" data-warning="${esc(b.warning ?? '')}"${b.ref === model.selectedBranch ? ' selected' : ''}>${esc(b.label)}${b.description ? ` — ${esc(b.description)}` : ''}</option>`,
    )
    .join('');

  const agentOptions = model.agents
    .map(
      (a) =>
        `<option value="${esc(a.id)}" data-detail="${esc(a.detail)}"${a.id === model.selectedAgent ? ' selected' : ''}>${esc(a.label)}${a.description ? ` (${esc(a.description)})` : ''}</option>`,
    )
    .join('');

  const selectedBranchObj = model.branches.find((b) => b.ref === model.selectedBranch);
  const selectedAgentObj = model.agents.find((a) => a.id === model.selectedAgent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New Session</title>
<style>
body{margin:0;padding:28px 32px 48px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:13px}
main{max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
header{display:flex;flex-direction:column;gap:6px}
h1{margin:0;font-size:22px;font-weight:600}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:11px}.mono{font-family:var(--vscode-editor-font-family);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;padding:14px 16px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-sideBar-background)}
.field{display:flex;flex-direction:column;gap:6px}
.field>span{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.static{min-height:28px;display:flex;align-items:center}
select,input[type=text],textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:6px 8px}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border-color:var(--vscode-dropdown-border);min-height:30px}
textarea{min-height:170px;resize:vertical;line-height:1.5;font-family:var(--vscode-editor-font-family);font-size:13px}
textarea:focus,select:focus,input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.warn{color:var(--vscode-charts-orange);font-size:12px;margin-top:2px;min-height:16px}
.preview{font-size:12px;color:var(--vscode-descriptionForeground)}
footer{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:flex-end;padding-top:6px;border-top:1px solid var(--vscode-panel-border)}
footer .hint{margin-right:auto;font-size:12px;color:var(--vscode-descriptionForeground)}
button{font:inherit;min-height:32px;padding:0 16px;border-radius:3px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-descriptionForeground)}
button.ghost:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}
.error{color:var(--vscode-errorForeground);font-size:12px;display:none}
.error.show{display:block}
</style>
</head>
<body>
<main>
  <header>
    <div class="muted small mono" id="branchPreview">Branch: ${esc(model.predictedBranch)}</div>
    <h1>${esc(model.heading)}</h1>
    ${model.subtitle ? `<div class="muted">${esc(model.subtitle)}</div>` : ''}
  </header>

  ${
    model.isAdhoc
      ? `<label class="field"><span>Session Title</span><input type="text" id="adhocTitle" placeholder="e.g. Investigate flaky CI pipeline" autofocus><div class="error" id="titleError">Please enter a title for the ad-hoc session.</div></label>`
      : ''
  }

  <div class="grid">
    ${repoControl}
    <label class="field">
      <span>Base Branch</span>
      <select id="branch">${branchOptions}</select>
      <div class="warn" id="branchWarn">${selectedBranchObj?.warning ? `⚠ ${esc(selectedBranchObj.warning)}` : ''}</div>
    </label>
    <label class="field">
      <span>Agent</span>
      <select id="agent">${agentOptions}</select>
      <div class="preview mono" id="agentDetail">${esc(selectedAgentObj?.detail ?? '')}</div>
    </label>
  </div>

  <label class="field" id="instructionsWrap">
    <span>Instructions (optional)</span>
    <textarea id="instructions" placeholder="${esc(model.descriptionPlaceholder)}"${model.isAdhoc ? '' : ' autofocus'}></textarea>
    <div class="small muted">Written into the session's <code>.workbench/TASK.md</code>. Your open files and main working tree are never touched.</div>
  </label>

  <footer>
    <span class="hint">Press <kbd>Ctrl+Enter</kbd> to start · <kbd>Esc</kbd> to cancel</span>
    <button type="button" class="ghost" id="cancel">Cancel</button>
    <button type="button" id="startBare">Start Without Prompt</button>
    <button type="button" class="primary" id="start">Start Session</button>
  </footer>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const repoEl = document.getElementById('repo');
const branchEl = document.getElementById('branch');
const branchWarnEl = document.getElementById('branchWarn');
const branchPreviewEl = document.getElementById('branchPreview');
const agentEl = document.getElementById('agent');
const agentDetailEl = document.getElementById('agentDetail');
const instructionsEl = document.getElementById('instructions');
const instructionsWrap = document.getElementById('instructionsWrap');
const startBtn = document.getElementById('start');
const startBareBtn = document.getElementById('startBare');
const cancelBtn = document.getElementById('cancel');
const adhocTitleEl = document.getElementById('adhocTitle');
const titleErrorEl = document.getElementById('titleError');
let selectedRepo = ${JSON.stringify(model.selectedRepo)};

function updateBranchWarn() {
  const opt = branchEl.options[branchEl.selectedIndex];
  const warn = opt ? opt.dataset.warning : '';
  branchWarnEl.textContent = warn ? '⚠ ' + warn : '';
}
function updateAgentUi() {
  const opt = agentEl.options[agentEl.selectedIndex];
  agentDetailEl.textContent = opt ? (opt.dataset.detail || '') : '';
  const isNone = agentEl.value === 'none';
  startBareBtn.style.display = isNone ? 'none' : '';
  startBtn.textContent = isNone ? 'Create Worktree' : 'Start Session';
  instructionsWrap.style.opacity = isNone ? '0.65' : '1';
}

branchEl.addEventListener('change', updateBranchWarn);
agentEl.addEventListener('change', updateAgentUi);
if (repoEl) {
  repoEl.addEventListener('change', () => {
    selectedRepo = repoEl.value;
    vscode.postMessage({ command: 'repoChanged', repoRoot: selectedRepo });
  });
}

function submit(bare) {
  if (adhocTitleEl && !adhocTitleEl.value.trim()) {
    titleErrorEl.classList.add('show');
    adhocTitleEl.focus();
    return;
  }
  const base = {
    repoRoot: repoEl ? repoEl.value : selectedRepo,
    baseRef: branchEl.value,
    agentId: agentEl.value,
    ...(adhocTitleEl ? { adhocTitle: adhocTitleEl.value.trim() } : {}),
  };
  if (bare || agentEl.value === 'none') {
    vscode.postMessage({ command: 'startBare', ...base });
  } else {
    vscode.postMessage({ command: 'start', ...base, instructions: instructionsEl.value.trim() });
  }
}

startBtn.addEventListener('click', () => submit(false));
startBareBtn.addEventListener('click', () => submit(true));
cancelBtn.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submit(false);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    vscode.postMessage({ command: 'cancel' });
  }
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'branches') return;
  branchEl.innerHTML = '';
  for (const b of msg.branches) {
    const opt = document.createElement('option');
    opt.value = b.ref;
    opt.dataset.warning = b.warning || '';
    opt.textContent = b.label + (b.description ? ' — ' + b.description : '');
    if (b.ref === msg.selectedBranch) opt.selected = true;
    branchEl.appendChild(opt);
  }
  if (msg.predictedBranch) {
    branchPreviewEl.textContent = 'Branch: ' + msg.predictedBranch;
  }
  updateBranchWarn();
});

updateAgentUi();
</script>
</body>
</html>`;
}
