import { runUsersCli } from '../src/users/users-cli.js';

process.exitCode = await runUsersCli(process.argv.slice(2));
