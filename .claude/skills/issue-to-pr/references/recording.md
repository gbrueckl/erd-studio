# Recording the before and after

Read this at step 6. The goal is two short clips of **the same scenario**:
- **BEFORE** on the base branch's build;
- **AFTER** on your branch.

Keep everything else identical: data, window size, steps and pacing. The viewer should be
able to see that only the code differs.

## The shape of a good scenario

- **15–40 seconds per side, 3–5 marks each.** Shorter is better. The reporter wants to
  see their problem, then see it gone.
- **Mirror the steps.** The AFTER clip replays the BEFORE steps exactly, then optionally
  adds one extra beat: the new affordance being used, or the boundary.
- **Show the boundary.** Include one moment that shows what deliberately did *not*
  change: the neighbouring case that still behaves, or the fallback. Without it, a scoped
  fix looks identical to one that broke something.
- **Reproduce the reporter's condition, not a tidy one.** If the bug needs four workspace
  folders, a long name or an empty state, build exactly that. Demo data is often too tidy
  to show the defect at all.
- **Feature requests have no "before" bug.** The BEFORE clip shows the old way: the
  hidden affordance, the extra steps, the missing option.

## Chromium surfaces: the CDP recorder (web apps, VS Code, Electron)

`scripts/cdp/` drives any Chromium surface over the DevTools protocol, with no dependencies
(Node 22 or later):

| File | Role |
|---|---|
| `cdp.mjs` | Connects to `CDP_PORT` (default 9333). `CDP_TARGET` selects the page by URL substring. `node cdp.mjs eval '<expr>'` and `node cdp.mjs shot x.jpg` are quick probes. |
| `recorder.mjs <dir>` | Screenshots the page continuously (about 10–13 fps) until `<dir>/STOP` exists, writing `times.txt`. It films only the page: no desktop and no notifications, and it needs no screen-recording permission. It survives page reloads. |
| `act.mjs` | Scripted actions with a visible gliding cursor, click ripples and highlight boxes, plus **`mark(text)`**, which logs a timestamped cue to `marks.jsonl`. Captions are *not* drawn on the page: `make_video.py` burns them in from the marks, so caption, narration and action start on the same frame. |

The recording loop is the same for every Chromium surface:

```bash
export CDP_PORT=9333                        # plus CDP_TARGET=workbench for VS Code
(node "$S/cdp/recorder.mjs" "$SCRATCH/rec/before" > "$SCRATCH/rec/before.log" 2>&1 &); sleep 1.5
MARKS="$SCRATCH/rec/before/marks.jsonl" node "$SCRATCH/rec/before.mjs"
touch "$SCRATCH/rec/before/STOP"; sleep 2; cat "$SCRATCH/rec/before.log"
```

A scenario script looks like this:

```js
import { session, sleep } from '<S>/cdp/act.mjs';
const a = await session();                       // uses $MARKS
await sleep(800);
await a.mark('Four folders in this workspace; the diagrams live in the fourth.');
await a.highlight(`document.querySelector('.explorer-folders-view')`); await sleep(2500); await a.unhighlight();
await a.mark('Open the ERD Studio sidebar.');
await a.click(`document.querySelector('.activitybar a[aria-label="ERD Studio"]')`);
await a.waitFor(`document.querySelector('.part.sidebar .monaco-list-row')`);
await sleep(1500);
await a.mark('It opened the first dbt project, so there are no diagrams.');
await sleep(3000);
a.close();
```

**Pace for the narration.** Leave about 2.5 s after each mark for a one-line caption.
`make_video.py` freezes the frame when a line runs long, but a video that keeps freezing
looks broken. Before recording for real, do a dry run of the script with no recorder, and
check each selector resolves using `node cdp.mjs eval`.

### Web app

1. Run the **before** build (from the worktree) and the **after** build on two different
   ports.
2. Launch an isolated Chrome for each:
   ```bash
   CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # Linux: google-chrome
   ("$CH" --headless=new --remote-debugging-port=9333 --user-data-dir="$SCRATCH/chrome-before" \
     --window-size=1600,1000 --hide-scrollbars "http://localhost:<before-port>/<path>" > /dev/null 2>&1 &)
   ```
   Headless keeps the recording free of the user's own browser, extensions and tabs.
3. Seed the same state in both: log in with the app's dev or test user, and create the
   condition through the UI.
4. Kill each Chrome by its `--user-data-dir` when finished.

### VS Code extension

This is the setup the #82 video (liam-machine/erd-studio) was made with:

1. **Copy each build out, then run the copy.**
   - `ext-before/`: the worktree's built output.
   - `ext-after/`: your branch's.

   Copy `dist/` (or `out/`), `package.json`, plus `media/` and any other runtime assets.
   Rebuilding in place while a window runs from it films a half-written bundle.
2. **Isolated profile:**
   ```bash
   U="$SCRATCH/vscode"; mkdir -p "$U"
   "/Applications/Visual Studio Code.app/Contents/MacOS/Code" --remote-debugging-port=9333 \
     --user-data-dir="$U/ud" --extensions-dir="$U/exts" --extensionDevelopmentPath="$SCRATCH/ext-before" \
     --new-window "$SCRATCH/demo/demo.code-workspace" > "$SCRATCH/code.log" 2>&1 &
   for i in $(seq 1 30); do curl -s 127.0.0.1:9333/json/list | grep -q workbench && break; sleep 1; done; sleep 6
   export CDP_TARGET=workbench
   ```
   Pre-write `$U/ud/User/settings.json` so the recording is clean:
   ```json
   {"workbench.startupEditor": "none", "security.workspace.trust.enabled": false,
    "workbench.tips.enabled": false, "update.mode": "none", "telemetry.telemetryLevel": "off",
    "workbench.colorTheme": "Default Dark Modern", "window.zoomLevel": 0}
   ```
3. **Switch builds by relaunching:**
   `pkill -f "$U/ud"; sleep 2; pkill -9 -f "$U/ud"`, then launch with the other
   `--extensionDevelopmentPath`. The same profile keeps the window size and state identical.
4. **Reset between takes:** close editor tabs, return to the Explorer, dismiss
   notifications. Write this as a small `reset.mjs` and run it before each recording.
5. **Some controls only appear on hover.** View-title actions show only while you hover
   the header. Either hover with `a.hover(expr)` first, or set
   `"workbench.view.alwaysShowHeaderActions": true`. If the *point* of the video is that
   the control was hidden, record with the default and say so in the caption.
6. **Some controls ignore synthetic events.** Webview iframes, the Monaco editor and
   native menus may not react to dispatched DOM events. Use `a.realClick(expr)` (trusted
   CDP input), or drive the step through the command palette: `a.key('F1', 'F1', 112)`,
   then `a.type('Select dbt Project')`, then Enter.
7. **Webview content** (custom editors) is a separate CDP target. List it with
   `curl 127.0.0.1:9333/json/list`, and attach a second `connect()` with that URL substring
   to act inside it. The recorder only needs the workbench, whose screenshot includes the
   webview.
8. **A window reload** drops the connection. The recorder reconnects on its own, and
   `act.mjs` retries with `waitFor` after the reload.

### ERD Studio: pick the lightest surface that shows the bug

| The bug lives in… | Record with | Why |
|---|---|---|
| The canvas only: nodes, edges, DetailPanel, dialogs, toolbar | **The webview in headless Chrome** (`dev-preview.html`, see `CLAUDE.md` "Testing the Webview UI in Chrome"). Build each side's `dist/` and serve them on two ports, with the same `domainLoaded` payload in both mocks. | No VS Code, no display. It works in a routine with only Chromium. |
| The workbench: sidebar trees, commands, notifications, Welcome panel, custom-editor lifecycle, file watchers | **Full VS Code** (the recipe above, or "Linux / headless" below) | The host side only runs inside VS Code |
| The CLI (`erd-studio doctor` / `diff` / `export` / `inventory`) | **Terminal segments**: `node dist/cli.js … --project test/fixtures/dbt-project` on both builds | The honest evidence is the output |
| Core / renderer packages with no visible change | Terminal segments of the new test, plus the golden diff | |

The mocked webview is the same bundle VS Code loads, but the host is fake. If the bug is
in what the **host** posts, capture the real payload first (in VS Code, log it from
`sendDomainData`) and paste it into the mock. Don't hand-write a payload that "should"
reproduce it.

### Linux / headless (a routine, or any machine without a screen)

VS Code is Electron, so it needs a display. Xvfb provides one, and the CDP recorder takes
screenshots over DevTools, so nothing reads the virtual screen itself.

```bash
export DISPLAY=:99; (Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp > "$SCRATCH/xvfb.log" 2>&1 &); sleep 1
CODE=/opt/vscode/code            # the setup script's install; locally `command -v code`
U="$SCRATCH/vscode"; mkdir -p "$U/ud/User"   # pre-write settings.json as above
("$CODE" --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9333 \
   --user-data-dir="$U/ud" --extensions-dir="$U/exts" --extensionDevelopmentPath="$SCRATCH/ext-before" \
   --new-window "$SCRATCH/demo" > "$SCRATCH/code.log" 2>&1 &)
for i in $(seq 1 45); do curl -s 127.0.0.1:9333/json/list | grep -q workbench && break; sleep 1; done; sleep 6
```

- **Root** (the cloud sandbox) needs `--no-sandbox`, and an explicit `--user-data-dir`:
  VS Code refuses to start as root without one.
- Add `"window.titleBarStyle": "custom"` and `"window.zoomLevel": 0` to settings.json.
  Linux defaults to the native title bar, which isn't in a CDP screenshot.
- The fonts are DejaVu, so screenshots won't match macOS pixel for pixel. That's fine
  for evidence, but record BEFORE and AFTER on the **same** machine.
- Headless Chromium for webview-only recordings: `npx playwright@1.63.0 install
  chromium`, then launch its binary with the same flags as the web-app recipe, plus
  `--no-sandbox` when running as root.

### Other Electron apps

Same as VS Code: start the app with `--remote-debugging-port=9333`, and use `CDP_TARGET`
to pick its main window.

## CLI tools, libraries and backends: terminal segments

When there is no UI, the evidence is the command itself: the same invocation on both
builds, with its real output. Capture it, then use a `term` segment (see `video.md`):

```bash
( cd "$SCRATCH/before" && <build> && <the reporter's command> ) > "$SCRATCH/video/before.txt" 2>&1
( <build> && <the reporter's command> ) > "$SCRATCH/video/after.txt" 2>&1
( <the new test command> ) > "$SCRATCH/video/tests.txt" 2>&1
```

Trim each capture to the lines that matter, no more than about 25. Keep the prompt line
(`$ mytool --flag`) at the top so the viewer knows what ran. Scrub absolute home paths and
tokens. For an API bug, `curl -s … | jq` before and after makes an honest pair.

## Stills

If something can only be screenshotted (a native dialog, or a mobile simulator via
`xcrun simctl io booted screenshot`), a `clip` segment accepts a `.png`/`.jpg` with a
`duration`, and cues on it work as usual.

## What never goes on camera

- Real customer or production data. Use fixtures or seeded demo data only.
- Tokens, `.env` contents, absolute home paths, personal notifications, and other tabs or
  windows.
- Anything the reporter shouldn't see about other users.

If the base build needs a secret to run, film against a local or mock backend instead,
and name that substitution in the PR.
