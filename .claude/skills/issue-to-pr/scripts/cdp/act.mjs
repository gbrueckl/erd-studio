// Scripted UI actions for a filmed scenario: a visible fake cursor that glides to its
// target, a click ripple, a highlight box — and MARKS, the timestamps make_video.py turns
// into captions + narration. Captions are burnt in afterwards (so they sync with the
// voice); nothing here draws text on the page.
//
//   import { session, sleep } from '<skill>/scripts/cdp/act.mjs';
//   const a = await session({ marks: 'rec/before/marks.jsonl' });
//   await a.mark('The sidebar shows no diagrams.');       // cue: caption + narration start here
//   await a.highlight(`document.querySelector('.part.sidebar')`);
//   await a.click(`document.querySelector('[aria-label="ERD Studio"]')`);
//   await a.waitFor(`document.querySelector('.monaco-list-row')`);
//
// Every target is a JS EXPRESSION evaluated in the page (so any selector logic works).
// Clicks are dispatched as DOM events on the element — robust against layout, but a
// control that only reacts to trusted input needs `a.realClick(expr)` (CDP Input events).
import fs from 'node:fs';
import { connect } from './cdp.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const OVERLAY = `(() => {
  if (document.getElementById('__cur')) return true;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;pointer-events:none;transition:transform .7s cubic-bezier(.4,.1,.2,1);transform:translate(50vw,50vh)}' +
    '#__ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #fbbf24;pointer-events:none;opacity:0}' +
    '#__hl{position:fixed;z-index:2147483644;border:3px solid #fbbf24;border-radius:6px;box-shadow:0 0 0 4000px rgba(0,0,0,.28);pointer-events:none;transition:all .45s;opacity:0}';
  document.head.appendChild(s);
  const cur = document.createElement('div'); cur.id = '__cur';
  const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z');
  p.setAttribute('fill', '#fff'); p.setAttribute('stroke', '#000'); p.setAttribute('stroke-width', '1.4');
  svg.appendChild(p); cur.appendChild(svg); document.body.appendChild(cur);
  for (const id of ['__ripple', '__hl']) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
  return true; })()`;

export async function session({ marks = process.env.MARKS } = {}) {
  let c = await connect();
  // survive page reloads: retry on a dead context, reconnecting as needed
  const ev = async (expr) => {
    for (let i = 0; i < 20; i++) {
      try { return await c.evaluate(expr); } catch (e) {
        if (!/closed|CLOSED|not open|Cannot find context|Execution context|Inspected target/.test(String(e))) throw e;
        await sleep(500); try { c = await connect(); } catch {}
      }
    }
    throw new Error('page never came back: ' + expr.slice(0, 80));
  };
  const center = (expr) => ev(`(() => { const el=${expr}; if(!el) return null; el.scrollIntoView?.({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
  await ev(OVERLAY);
  const a = {
    ev,
    /** A cue: caption + narration begin at this instant. Text is the caption; the narration
     *  defaults to it (override `say` in the storyboard). */
    async mark(text) {
      if (!marks) throw new Error('session({ marks: "<frames dir>/marks.jsonl" }) or MARKS=… is required for mark()');
      fs.appendFileSync(marks, JSON.stringify({ t: Date.now(), text }) + '\n');
    },
    async waitFor(expr, ms = 15000) {
      const t = Date.now();
      while (Date.now() - t < ms) { if (await ev(`!!(${expr})`)) return; await sleep(200); }
      throw new Error('timeout waiting for ' + expr);
    },
    async highlight(expr, pad = 4) {
      await ev(OVERLAY);
      return ev(`(() => { const h=document.getElementById('__hl'); const el=${expr}; if(!el){h.style.opacity=0;return false;}
        const r=el.getBoundingClientRect(); Object.assign(h.style,{left:(r.left-${pad})+'px',top:(r.top-${pad})+'px',
        width:(r.width+2*${pad})+'px',height:(r.height+2*${pad})+'px',opacity:1}); return true; })()`);
    },
    async unhighlight() { await ev(`(document.getElementById('__hl')||{style:{}}).style.opacity=0`); },
    async moveTo(expr) {
      await ev(OVERLAY);
      const p = await center(expr);
      if (!p) throw new Error('not found: ' + expr);
      await ev(`document.getElementById('__cur').style.transform='translate(${p.x - 4}px,${p.y - 2}px)'`);
      await sleep(800);
      return p;
    },
    async click(expr, { dbl = false } = {}) {
      const p = await a.moveTo(expr);
      await ev(`(() => { const el=${expr}; const x=${p.x}, y=${p.y};
        const rp=document.getElementById('__ripple'); rp.style.left=x+'px'; rp.style.top=y+'px';
        rp.animate([{opacity:1,transform:'scale(.4)'},{opacity:0,transform:'scale(1.6)'}],{duration:500});
        const o={bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,view:window};
        for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,o));
        if (${dbl}) el.dispatchEvent(new MouseEvent('dblclick',o)); return true; })()`);
      await sleep(400);
    },
    /** Trusted click through CDP Input events — for controls that ignore synthetic DOM events. */
    async realClick(expr) {
      const p = await a.moveTo(expr);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      await sleep(400);
    },
    async hover(expr) {
      const p = await a.moveTo(expr);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    },
    async key(key, code = key, keyCode = 0, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    async type(text, perChar = 45) {
      for (const ch of text) { await c.send('Input.insertText', { text: ch }); await sleep(perChar); }
    },
    close: () => c.close(),
  };
  return a;
}
