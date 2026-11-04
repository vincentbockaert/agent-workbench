// Stub worklog command: prints the WB_* variables it received as JSON.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('WB_')));
process.stdout.write(JSON.stringify(env));
