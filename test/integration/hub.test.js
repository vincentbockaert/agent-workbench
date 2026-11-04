const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

suite('ticket hub', () => {
  const fixtures = path.join(__dirname, '..', 'fixtures');
  const source = {
    name: 'GitHub',
    listCmd: `node "${path.join(fixtures, 'print-file.js')}" "${path.join(fixtures, 'gh-issues.json')}"`,
    map: { id: 'number', title: 'title', status: 'state', url: 'url' },
  };

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('agentWorkbench').update('ticketSources', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('opens a ticket as an editor tab, once per ticket', async () => {
    await vscode.extensions.getExtension('local.agent-workbench').activate();
    await vscode.workspace.getConfiguration('agentWorkbench').update('ticketSources', [source], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('agentWorkbench.refreshTickets');

    const node = { kind: 'ticket', group: { ticket: { source: 'GitHub', id: '42', title: 'Crash on empty config' }, listed: true, sessions: [] } };
    await vscode.commands.executeCommand('agentWorkbench.openTicketHub', node);
    await vscode.commands.executeCommand('agentWorkbench.openTicketHub', node);

    // Tabs update asynchronously after the panel is created.
    const hubTabs = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('agentWorkbench.ticketHub'));
    for (let i = 0; i < 20 && hubTabs().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const all = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => `${t.label} ${t.input && t.input.viewType}`);
    assert.equal(hubTabs().length, 1, `expected exactly one hub tab, tabs: ${JSON.stringify(all)}`);
    assert.equal(hubTabs()[0].label, '42');
  });
});
