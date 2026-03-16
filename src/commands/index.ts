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
import { registerCompletionsCommand } from './completions.js';
import { registerListCommand } from './list.js';
import { registerRemoveCommand } from './remove.js';
import { registerDoctorCommand } from './doctor.js';

export function registerCommands(program: Command): void {
  registerInitCommand(program);
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerAddCommand(program);
  registerRemoveCommand(program);
  registerListCommand(program);
  registerScanCommand(program);
  registerPushCommand(program);
  registerPullCommand(program);
  registerStatusCommand(program);
  registerSecretCommand(program);
  registerCompletionsCommand(program);
  registerDoctorCommand(program);
}
