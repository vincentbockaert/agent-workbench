import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code instance; unit tests (npm test) do not.
export default defineConfig({
  files: 'test/integration/**/*.test.js',
  version: 'stable',
  mocha: { timeout: 20000 },
});
