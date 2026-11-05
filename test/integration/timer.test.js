const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// The extension's global storage inside the test instance's user data folder.
const logDir = path.join(__dirname, '..', '..', '.vscode-test', 'user-data', 'User', 'globalStorage', 'local.agent-workbench', 'timelog');

function events() {
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')) : [];
  return files.flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const clockEvents = (ticket) => events().filter((e) => e.session === 'clock' && e.ticket === ticket);
const node = (id) => ({ kind: 'ticket', group: { ticket: { source: 'IntTest', id } } });

suite('timer', () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension('local.agent-workbench').activate();
  });

  test('Start Timer puts a ticket on the clock and Stop Timer takes it off, both in the log', async () => {
    await vscode.commands.executeCommand('agentWorkbench.startTimer', node('1'));
    assert.deepStrictEqual(clockEvents('IntTest:1').map((e) => e.type), ['clock-on']);
    await vscode.commands.executeCommand('agentWorkbench.stopTimer', node('1'));
    assert.deepStrictEqual(clockEvents('IntTest:1').map((e) => e.type), ['clock-on', 'clock-off']);
  });

  test('starting the same ticket twice logs one clock-on, and stopping one that is off logs nothing', async () => {
    await vscode.commands.executeCommand('agentWorkbench.startTimer', node('2'));
    await vscode.commands.executeCommand('agentWorkbench.startTimer', node('2'));
    await vscode.commands.executeCommand('agentWorkbench.stopTimer', node('3'));
    assert.deepStrictEqual(clockEvents('IntTest:2').map((e) => e.type), ['clock-on']);
    assert.deepStrictEqual(clockEvents('IntTest:3'), []);
    await vscode.commands.executeCommand('agentWorkbench.stopTimer', node('2'));
  });

  test('starting a second ticket while one runs keeps both on the clock', async () => {
    await vscode.commands.executeCommand('agentWorkbench.startTimer', node('4'));
    await vscode.commands.executeCommand('agentWorkbench.startTimer', node('5'));
    await vscode.commands.executeCommand('agentWorkbench.stopTimer', node('4'));
    await vscode.commands.executeCommand('agentWorkbench.stopTimer', node('5'));
    assert.deepStrictEqual(clockEvents('IntTest:4').map((e) => e.type), ['clock-on', 'clock-off']);
    assert.deepStrictEqual(clockEvents('IntTest:5').map((e) => e.type), ['clock-on', 'clock-off']);
  });

  test('ignores a node that is neither a ticket nor a session', async () => {
    await vscode.commands.executeCommand('agentWorkbench.startTimer', { kind: 'other', sessions: [] });
    await vscode.commands.executeCommand('agentWorkbench.startTimer');
  });
});
