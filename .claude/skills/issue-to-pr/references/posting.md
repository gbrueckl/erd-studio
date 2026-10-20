# Shipping: the PR, the upload and the issue reply

Read this at step 7, as soon as the video has rendered and you have checked its contact sheet.
Raise the PR and post on the issue straight away. **Don't merge**: that waits for the user.

## 1. Push and open the PR

```bash
git push -u origin <branch>
gh pr create --base develop --head <branch> --title "<type>: <what is now true> (#<n>)" --body-file "$SCRATCH/pr-body.md"
```

Follow the repo's own conventions first: PR template, title style, changelog, labels. The
body looks like this; the video URL gets filled in after step 2:

```markdown
Closes #<n>

<VIDEO_URL>

## Problem
<the report in one or two sentences, quoting the reporter where it helps>

## Cause
<the mechanism, with `path/file.ts:123` references; say so if the fix is a deletion>

## Fix
<what changed and why it lives there; the council's verdict in a sentence>

<details><summary>Council</summary>

| Councillor | Recommended | Key risk |
|---|---|---|
| … | … | … |

**Verdict:** … **Overrode:** …
</details>

## Ripple check
From the Impact Scout's map and its re-audit of the diff. Every row ends done, ruled out
or flagged.

| Item | Status | Where / why |
|---|---|---|
| e.g. `HARNESS_VERSION` bump + fixture harness regen | ✅ done | `src/services/harnessService.ts:30`, `test/fixtures/…` |
| e.g. same parse in `src/cli/diff.ts` | ➖ ruled out | the CLI goes through `computeSubjectAreaDiff`, already fixed there |
| e.g. Confluence app cache key | ⚠️ flagged | new optional `DisplayTable` field; no bump needed, but noting it |

## Deliberately not changed
<the boundary: what a reviewer might worry this touched, and why it didn't>

## Video
| Part | Shows |
|---|---|
| Before (`<base>`) | … |
| After (this PR) | … |

## Tests
<the new test and the rule it pins; the gate commands you ran and their results>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 2. Upload the video to get an embeddable URL

GitHub renders an inline video player only for its own attachment URLs
(`https://github.com/user-attachments/assets/<uuid>`). There's no public API that creates
one, and a link to a file committed in the repo shows as a plain link. So the upload goes
through the comment box in the user's own logged-in Chrome, using the `claude-in-chrome`
tools, and the URL is read back **without posting anything from the browser**.

1. Load the tools in one ToolSearch call:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__find,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_close_mcp`
2. `tabs_context_mcp` with `createIfEmpty: true`, then `tabs_create_mcp` for a **new
   tab**. Never take over one of the user's tabs.
3. `navigate` to the **PR** URL. Its comment box works, and a stray draft there is
   harmless.
4. `find` with the query `"file input for attaching files to the new comment box at the
   bottom"`. It returns the `type="file"` input's `ref`.
5. `file_upload` with `{tabId, ref, paths: ["<abs path to the .mp4>"]}`.
6. `javascript_tool` (`javascript_exec`) to wait for GitHub to finish processing, capture
   the URL, and **clear the draft**:
   ```js
   const re = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}/;
   let url = null;
   for (let i = 0; i < 60 && !url; i++) {
     const t = [...document.querySelectorAll('textarea')].find(t => re.test(t.value));
     if (t) {
       url = t.value.match(re)[0];
       const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
       set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }));
     } else await new Promise(r => setTimeout(r, 1500));
   }
   url ?? 'NOT READY: ' + [...document.querySelectorAll('textarea')].map(t => t.value.slice(0, 120)).join(' | ')
   ```
   Keep the wait inside one call and never reload the page during it: a navigation
   mid-evaluation kills the call.
7. `tabs_close_mcp` on that tab.

**Never click "Comment" in the browser.** The comment is posted with `gh` in step 3, where
its text is under your control.

**If Chrome isn't connected**, or the upload fails twice:
1. Post the PR and the issue comment without the video.
2. Tell the user exactly where the file is.
3. Explain that dragging it into a comment on the issue embeds it, and offer to update the
   comment once they have the URL.

Don't substitute a repo link or a third-party host.

Access follows the repo. On a private repo, the video is visible only to people who can
see the repo, which includes the reporter if they could file the issue.

Then put the URL into the PR body: `gh pr edit <pr> --body-file …`.

## 3. Reply on the issue

Keep it short, and write it for the reporter rather than the reviewer: no file paths, no
internals. This is the shape that worked on liam-machine/erd-studio#82:

```markdown
Hi @<reporter>, thanks for the report. <The cause in one plain sentence.>

The fix in #<pr>:
- <what they will now see or be able to do>
- <a second point only if it matters to them, e.g. a new command, a setting, a limit>

Before/after video:

<VIDEO_URL>

Could you give it a try and let me know whether this solves it for you? Any feedback is welcome, and a 👍 is enough if it does.
```

```bash
gh issue comment <n> --body-file "$SCRATCH/issue-comment.md"
```

A few rules:
- **The video URL goes on its own line**, with a blank line before and after, or GitHub
  won't render the player.
- If the reporter is a maintainer or the user themselves, drop the greeting and the "could
  you confirm".
- For a feature request, open with what they can now do, not with "thanks for the report".
- If it isn't released yet, say so: "It'll be in the next release once #<pr> merges." Never
  say it's fixed in a version that doesn't exist.

## 4. After posting

- Check the rendering: `gh issue view <n> --comments | tail -20` should show the URL alone
  on its line.
- If the repo has CI, run `gh pr checks <pr> --watch`. Read any failure before touching
  code. A failing check on a file you didn't change is probably pre-existing; say so rather
  than "fixing" it inside this PR.
- Report to the user:
  - the PR URL and the issue comment URL;
  - the check status;
  - what you deliberately didn't change;
  - anything found but not fixed;
  - that the PR is open and **waiting for their say-so to merge**.
