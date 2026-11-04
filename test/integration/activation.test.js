const assert = require('assert');
const vscode = require('vscode');

suite('activation', () => {
  test('extension activates and its view can be focused', async () => {
    const ext = vscode.extensions.getExtension('local.agent-workbench');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.equal(ext.isActive, true);
    // Each contributed view gets a "<id>.focus" command; executing it proves the view is registered.
    await vscode.commands.executeCommand('agentWorkbench.work.focus');
  });

  test('refreshing with no ticket sources configured succeeds', async () => {
    await vscode.commands.executeCommand('agentWorkbench.refreshTickets');
  });
});
