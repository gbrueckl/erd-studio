// Minimal Chrome DevTools Protocol client — no dependencies (Node >= 22 has WebSocket).
// Works against anything Chromium that was started with --remote-debugging-port:
// VS Code / Electron apps, and Chrome itself pointed at a local web app.
//
//   CDP_PORT    default 9333
//   CDP_TARGET  substring of the page URL to attach to (VS Code: "workbench").
//               Default: the first "page" target.
import fs from 'node:fs';

export async function connect(port = Number(process.env.CDP_PORT || 9333), match = process.env.CDP_TARGET || '') {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && (!match || t.url.includes(match)));
  if (!page) throw new Error(`no page target${match ? ` matching "${match}"` : ''} on :${port} — ${list.map(t => t.url).join(', ')}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
  return { send, evaluate, shot, close: () => ws.close() };
}

// CLI: `node cdp.mjs eval '<expr>'` or `node cdp.mjs shot out.jpg` — quick probes while scripting.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const c = await connect();
  if (cmd === 'eval') console.log(JSON.stringify(await c.evaluate(arg), null, 1));
  else if (cmd === 'shot') { await c.shot(arg || 'shot.jpg'); console.log(arg || 'shot.jpg'); }
  else console.log('usage: node cdp.mjs eval <expr> | shot <file.jpg>');
  c.close();
}
