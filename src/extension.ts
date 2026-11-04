import * as vscode from 'vscode';
import { WORK_VIEW_ID } from './constants';

// Placeholder tree: tickets and sessions are added in later phases.
class WorkTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(WORK_VIEW_ID, new WorkTreeProvider()),
  );
}

export function deactivate(): void {}
