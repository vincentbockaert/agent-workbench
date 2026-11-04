// Stub ticket command that fails like an unauthenticated CLI would.
process.stderr.write('not logged in\n');
process.exit(4);
