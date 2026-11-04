// Stub ticket command: prints the file given as argument to stdout.
process.stdout.write(require('fs').readFileSync(process.argv[2], 'utf8'));
