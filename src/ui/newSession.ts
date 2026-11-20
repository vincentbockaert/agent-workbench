import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import {
  NewSessionBranchOption,
  NewSessionResult,
  NewSessionViewModel,
  parseNewSessionMessage,
  renderNewSessionHtml,
} from './newSessionView';

export type { NewSessionAgentOption, NewSessionBranchOption, NewSessionRepoOption, NewSessionResult, NewSessionViewModel } from './newSessionView';

export interface AskNewSessionOptions {
  initial: NewSessionViewModel;
  onRepoChange: (repoRoot: string) => Promise<{ branches: NewSessionBranchOption[]; selectedBranch: string; predictedBranch: string }>;
}

// Opens a single-screen New Session webview panel (replacing the multi-step QuickPick + scratch file flow).
export function askNewSession(opts: AskNewSessionOptions): Promise<NewSessionResult | undefined> {
  const panel = vscode.window.createWebviewPanel('agentWorkbench.newSession', `New Session · ${opts.initial.heading}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = renderNewSessionHtml(opts.initial, randomBytes(16).toString('hex'), panel.webview.cspSource);

  return new Promise<NewSessionResult | undefined>((resolve) => {
    let settled = false;
    const finish = (result: NewSessionResult | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      panel.dispose();
    };
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
    panel.webview.onDidReceiveMessage(async (raw) => {
      const msg = parseNewSessionMessage(raw);
      if (!msg) {
        return;
      }
      switch (msg.command) {
        case 'cancel':
          finish(undefined);
          return;
        case 'repoChanged': {
          const next = await opts.onRepoChange(msg.repoRoot);
          void panel.webview.postMessage({ type: 'branches', ...next });
          return;
        }
        case 'start':
          finish({
            repoRoot: msg.repoRoot,
            baseRef: msg.baseRef,
            agentId: msg.agentId,
            instructions: msg.instructions,
            withPrompt: msg.instructions.trim() !== '',
            adhocTitle: msg.adhocTitle,
          });
          return;
        case 'startBare':
          finish({
            repoRoot: msg.repoRoot,
            baseRef: msg.baseRef,
            agentId: msg.agentId,
            instructions: '',
            withPrompt: false,
            adhocTitle: msg.adhocTitle,
          });
          return;
      }
    });
  });
}
