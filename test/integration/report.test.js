const assert = require('assert');
const vscode = require('vscode');

suite('time report', () => {
  suiteTeardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  test('opens one "Time Report" tab, reused on the next open', async () => {
    await vscode.extensions.getExtension('local.agent-workbench').activate();
    await vscode.commands.executeCommand('agentWorkbench.timeReport');
    await vscode.commands.executeCommand('agentWorkbench.timeReport');

    // Tabs update asynchronously after the panel is created.
    const reportTabs = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('agentWorkbench.timeReport'));
    for (let i = 0; i < 20 && reportTabs().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(reportTabs().length, 1);
    assert.equal(reportTabs()[0].label, 'Time Report');
  });
});
