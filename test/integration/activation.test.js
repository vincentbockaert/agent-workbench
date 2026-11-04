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

  test('registers every command declared in package.json', async () => {
    const ext = vscode.extensions.getExtension('local.agent-workbench');
    await ext.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of ext.packageJSON.contributes.commands) {
      assert.ok(registered.has(command), `${command} is declared but not registered`);
    }
  });

  test('refreshing with no ticket sources configured succeeds', async () => {
    await vscode.commands.executeCommand('agentWorkbench.refreshTickets');
  });
});
