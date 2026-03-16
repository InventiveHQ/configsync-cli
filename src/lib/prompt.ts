/**
 * Password and input prompting utilities.
 */

let stdinLines: string[] | null = null;

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
 */
export async function promptPassword(prompt: string): Promise<string> {
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
