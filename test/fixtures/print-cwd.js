// Stub ticket command: prints one ticket whose id is the name of the folder it runs in.
const name = require('path').basename(process.cwd());
process.stdout.write(JSON.stringify([{ id: name + '-1', title: 'Ticket of ' + name }]));
