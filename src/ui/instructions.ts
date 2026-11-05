import * as vscode from 'vscode';
import { extractInstructions, instructionsTemplate } from '../sessions/instructions';

export const COMPOSING_CONTEXT = 'agentWorkbench.composingInstructions';
export const START_AGENT_COMMAND = 'agentWorkbench.startAgentWithInstructions';

let pending: { doc: vscode.TextDocument; finish: (text: string) => void } | undefined;

function setComposing(on: boolean): void {
  void vscode.commands.executeCommand('setContext', COMPOSING_CONTEXT, on);
}

// Opens a scratch markdown tab for the user to write the agent's first request in. Resolves with the text
// when they click "Start Agent", or with '' when they leave it empty or close the tab (start without a prompt).
// Resolves undefined, without opening anything, if such a tab is already open.
export async function askInstructions(label: string): Promise<string | undefined> {
  if (pending) {
    await vscode.window.showTextDocument(pending.doc, { preview: false });
    return undefined;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: instructionsTemplate(label) });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.positionAt(doc.getText().length);
  editor.selection = new vscode.Selection(end, end);
  setComposing(true);

  return new Promise<string>((resolve) => {
    const closed = vscode.workspace.onDidCloseTextDocument((d) => {
      if (d === doc) {
        finish('');
      }
    });
    function finish(text: string): void {
      if (pending?.doc !== doc) {
        return; // already answered
      }
      pending = undefined;
      closed.dispose();
      setComposing(false);
      resolve(text);
    }
    pending = { doc, finish };
  });
}

// The "Start Agent" button of the instructions tab.
export async function startWithInstructions(): Promise<void> {
  const current = pending;
  if (!current) {
    return;
  }
  const text = extractInstructions(current.doc.getText());
  current.finish(text);
  // Close the scratch tab without a "save changes?" question (revert only applies to an edited document).
  await vscode.window.showTextDocument(current.doc, { preview: false });
  await vscode.commands.executeCommand(current.doc.isDirty ? 'workbench.action.revertAndCloseActiveEditor' : 'workbench.action.closeActiveEditor');
}
