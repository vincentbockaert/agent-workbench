// The text a user writes in the "instructions" editor before an agent starts.
// The hint at the top is an HTML comment, so an untouched template means "no instructions".
const HINT = /^\s*<!--[\s\S]*?-->/;

export function instructionsTemplate(label: string): string {
  const safe = label.replace(/-->/g, '--&gt;');
  return `<!-- Instructions for the agent on ${safe}. Write below, then click "Start Agent" (top right). Leave empty or close this tab to start the agent without a prompt. -->\n\n`;
}

export function extractInstructions(text: string): string {
  return text.replace(HINT, '').trim();
}
