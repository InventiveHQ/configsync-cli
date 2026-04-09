/**
 * Password and input prompting utilities.
 */
import fs from 'node:fs';

let stdinLines: string[] | null = null;

/**
 * Resolve a master password from the environment, bypassing the interactive
 * prompt. Resolution order:
 *
 *   1. CONFIGSYNC_MASTER_PASSWORD env var (verbatim password)
 *   2. CONFIGSYNC_MASTER_PASSWORD_FILE env var (path to a file containing the password)
 *
 * Intended for testing, CI, and automation. The env var name is intentionally
 * verbose to avoid collision with API token env vars.
 *
 * Returns null if neither is set, in which case callers should fall back to
 * the interactive prompt.
 */
export function passwordFromEnv(): string | null {
  const direct = process.env.CONFIGSYNC_MASTER_PASSWORD;
  if (direct !== undefined && direct !== '') {
    return direct;
  }

  const filePath = process.env.CONFIGSYNC_MASTER_PASSWORD_FILE;
  if (filePath) {
    try {
      // Trim trailing newline (common when writing with `echo` or text editors)
      return fs.readFileSync(filePath, 'utf-8').replace(/\r?\n$/, '');
    } catch (err: any) {
      throw new Error(
        `CONFIGSYNC_MASTER_PASSWORD_FILE is set but cannot be read: ${filePath} (${err.message})`,
      );
    }
  }

  return null;
}

async function readAllStdin(): Promise<string[]> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data.split('\n').filter(l => l.length > 0)); });
    process.stdin.resume();
  });
}

/**
 * Prompt for a password with hidden input (no echo to terminal).
 *
 * If `CONFIGSYNC_MASTER_PASSWORD` or `CONFIGSYNC_MASTER_PASSWORD_FILE` is set
 * in the environment, the value is returned without prompting. This is the
 * recommended way to script ConfigSync (env vars are not visible in `ps`
 * output the way command-line flags would be).
 */
export async function promptPassword(prompt: string): Promise<string> {
  // Environment override (for testing / CI / automation)
  const fromEnv = passwordFromEnv();
  if (fromEnv !== null) {
    return fromEnv;
  }

  // If stdin is a TTY, use raw mode for hidden input
  if (process.stdin.isTTY) {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      let password = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (ch: string) => {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
        } else if (ch === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.exit(1);
        } else if (ch === '\u007F' || ch === '\b') {
          password = password.slice(0, -1);
        } else {
          password += ch;
        }
      };

      process.stdin.on('data', onData);
    });
  }

  // Non-TTY: read all stdin lines upfront, return them in order
  if (!stdinLines) {
    stdinLines = await readAllStdin();
  }

  process.stdout.write(prompt);
  const line = stdinLines.shift() || '';
  process.stdout.write('\n');
  return line;
}
