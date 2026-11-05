const assert = require('assert');
const vscode = require('vscode');

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    const v = check();
    if (v) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const composeEditor = () => {
  const e = vscode.window.activeTextEditor;
  return e && e.document.uri.scheme === 'untitled' && e.document.languageId === 'markdown' ? e : undefined;
};
const openTabsOf = (doc) => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && t.input.uri.toString() === doc.uri.toString());

suite('instructions editor', () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension('local.agent-workbench').activate();
  });
  teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  test('opens a markdown tab with a hint and returns what was written once Start Agent runs, closing the tab', async () => {
    const result = vscode.commands.executeCommand('agentWorkbench.askInstructions', 'HDO-1 Fix the thing');
    const editor = await waitFor(composeEditor, 'the instructions editor');
    assert.match(editor.document.getText(), /HDO-1 Fix the thing/);
    await editor.edit((e) => e.insert(editor.document.positionAt(editor.document.getText().length), 'Start with the parser.'));
    await vscode.commands.executeCommand('agentWorkbench.startAgentWithInstructions');
    assert.strictEqual(await result, 'Start with the parser.');
    await waitFor(() => openTabsOf(editor.document).length === 0, 'the tab to close');
  });

  test('returns an empty string when Start Agent runs on the untouched template', async () => {
    const result = vscode.commands.executeCommand('agentWorkbench.askInstructions', 'X');
    await waitFor(composeEditor, 'the instructions editor');
    await vscode.commands.executeCommand('agentWorkbench.startAgentWithInstructions');
    assert.strictEqual(await result, '');
  });

  test('returns an empty string when the tab is closed', async () => {
    const result = vscode.commands.executeCommand('agentWorkbench.askInstructions', 'X');
    await waitFor(composeEditor, 'the instructions editor');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.strictEqual(await result, '');
  });

  test('does not open a second editor while one is open, and answers undefined', async () => {
    const first = vscode.commands.executeCommand('agentWorkbench.askInstructions', 'A');
    const editor = await waitFor(composeEditor, 'the instructions editor');
    assert.strictEqual(await vscode.commands.executeCommand('agentWorkbench.askInstructions', 'B'), undefined);
    assert.strictEqual(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'untitled').length, 1);
    await vscode.commands.executeCommand('agentWorkbench.startAgentWithInstructions');
    assert.strictEqual(await first, '');
    assert.ok(editor);
  });

  test('Start Agent does nothing when no instructions editor is open', async () => {
    await vscode.commands.executeCommand('agentWorkbench.startAgentWithInstructions');
  });
});
