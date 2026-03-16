import { Command } from 'commander';
import { registerCommands } from './commands/index.js';

const program = new Command();
program
  .name('configsync')
  .description('ConfigSync - Sync your development environment across machines')
  .version('0.1.0');

registerCommands(program);
program.parse();
