import { runUsersCli } from './users/users-cli.js';

process.exitCode = await runUsersCli(process.argv.slice(2));
