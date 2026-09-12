import { spawn } from 'node:child_process';

/**
 * Open a URL in the default browser.
 *
 * Windows deliberately does NOT go through `cmd /c start`: cmd reads the &
 * between query parameters as a command separator, so the browser receives a
 * truncated URL. rundll32 hands the URL to the default handler with no shell
 * in between.
 */
export function openBrowser(url) {
  const commands = {
    win32: ['rundll32', ['url.dll,FileProtocolHandler', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
  };
  const cmd = commands[process.platform];
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    // A missing binary arrives as an async error event, which would otherwise
    // take the whole script down. Printing the URL is the real fallback.
    child.on('error', () => {});
    child.unref();
  } catch {
    // same
  }
}
