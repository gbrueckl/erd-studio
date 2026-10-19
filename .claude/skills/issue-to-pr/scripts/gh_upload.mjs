// Upload a file to GitHub's attachment store through a logged-in Chromium profile and print
// the https://github.com/user-attachments/assets/<uuid> URL — the unattended twin of the
// claude-in-chrome steps in references/posting.md, for machines with no Chrome extension
// (the Raspberry Pi runner, references/pi.md). Nothing is ever posted: the draft it leaves in
// the comment box is cleared before the browser closes.
//
//   node gh_upload.mjs --url <PR or issue URL> --file <abs path>   → prints the URL
//   node gh_upload.mjs --check                                      → prints the GitHub login
//
// Env: ISSUE_BOT_PROFILE (default ~/.config/issue-bot/chromium), ISSUE_BOT_CHROMIUM (default
// chromium), UPLOAD_CDP_PORT (default 9445), DISPLAY (an Xvfb screen; required).
//
// The browser is started HEADED on that display, never --headless: GitHub ends a session the
// first time a HeadlessChrome user agent presents its cookie.
//
// Exit codes: 0 ok · 2 usage · 3 not logged in to GitHub · 4 upload did not finish.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp/cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const check = args.check === true;
if (!check && (typeof args.url !== 'string' || typeof args.file !== 'string')) {
  console.error('usage: node gh_upload.mjs --url <PR/issue URL> --file <path> | --check'); process.exit(2);
}
if (!process.env.DISPLAY) { console.error('DISPLAY is not set — start Xvfb first'); process.exit(2); }
const file = check ? null : path.resolve(args.file);
if (file && !fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2); }

const profile = process.env.ISSUE_BOT_PROFILE || path.join(os.homedir(), '.config/issue-bot/chromium');
const port = Number(process.env.UPLOAD_CDP_PORT || 9445);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(process.env.ISSUE_BOT_CHROMIUM || 'chromium', [
  `--user-data-dir=${profile}`, '--password-store=basic', '--ozone-platform=x11',
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore', detached: true });

let c;
for (let i = 0; i < 30 && !c; i++) { await sleep(1000); try { c = await connect(port); } catch { /* not up yet */ } }
if (!c) { console.error('Chromium did not start'); process.exit(4); }

// Browser.close (not a signal) so the cookie store is flushed and the session it refreshed survives.
async function finish(code, out) {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    for (let i = 0; i < 15 && chrome.exitCode === null; i++) await sleep(1000);
  } catch { /* already gone */ }
  if (chrome.exitCode === null) try { process.kill(-chrome.pid); } catch { /* gone */ }
  if (out) console.log(out);
  process.exit(code);
}

async function open(url) {
  await c.send('Page.enable');
  await c.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await c.evaluate('document.readyState') === 'complete') break;
  }
  await sleep(2000);
}

await open(check ? 'https://github.com/settings/profile' : args.url);
const login = await c.evaluate(`document.querySelector('meta[name="user-login"]')?.content || ''`);
if (!login) { console.error('NOT_LOGGED_IN: the bot profile has no GitHub session (see references/pi.md)'); await finish(3); }
if (check) await finish(0, login);

// The new-comment box is the last comment form on a PR or issue page; its file input is the
// last one in the document. Tag it so DOM.querySelector can hand CDP a node id for it.
const tagged = await c.evaluate(`(() => {
  const inputs = [...document.querySelectorAll('input[type=file]')].filter(i => !i.closest('.js-comment-edit-form, [data-testid="edit-comment"]'));
  const el = inputs.at(-1); if (!el) return false;
  el.setAttribute('data-issue-bot-upload', '1'); return true;
})()`);
if (!tagged) { console.error('no file input found on the page'); await finish(4); }
const { root } = await c.send('DOM.getDocument', { depth: -1 });
const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-issue-bot-upload]' });
await c.send('DOM.setFileInputFiles', { nodeId, files: [file] });

// Same capture-and-clear as posting.md step 6: wait for GitHub to finish processing, read the
// URL out of the textarea, then empty it with React's own setter so no draft is kept.
const url = await c.evaluate(`(async () => {
  const re = /https:\\/\\/github\\.com\\/user-attachments\\/assets\\/[0-9a-f-]{36}/;
  for (let i = 0; i < 120; i++) {
    const t = [...document.querySelectorAll('textarea')].find(t => re.test(t.value));
    if (t) {
      const u = t.value.match(re)[0];
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }));
      return u;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
})()`);
if (!url) { console.error('upload did not finish within 3 minutes'); await finish(4); }
await sleep(1500);
await finish(0, url);
