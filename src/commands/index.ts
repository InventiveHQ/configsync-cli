import { Command } from 'commander';
import { registerInitCommand } from './init.js';
import { registerLoginCommand } from './login.js';
import { registerLogoutCommand } from './logout.js';
import { registerAddCommand } from './add.js';
import { registerPushCommand } from './push.js';
import { registerPullCommand } from './pull.js';
import { registerStatusCommand } from './status.js';
import { registerSecretCommand } from './secret.js';
import { registerScanCommand } from './scan.js';

export function registerCommands(program: Command): void {
  registerInitCommand(program);
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerAddCommand(program);
  registerScanCommand(program);
  registerPushCommand(program);
  registerPullCommand(program);
  registerStatusCommand(program);
  registerSecretCommand(program);
}
