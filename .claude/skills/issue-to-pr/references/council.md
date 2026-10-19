# The council: five councillors and a scout, one decision

Read this at step 4, once you understand the issue well enough to explain it.

The council has **five councillors and a survey**:
- **three perspectives**, chosen fresh for each issue, who argue about *how* to fix it;
- **two standing councillors**, the same on every issue:
  - **the Reproducer**, who proves the bug on `origin/develop` with a failing test before
    anyone settles on a fix (see "The Reproducer" below);
  - **the Breaker**, who assumes the fix has shipped and failed, and finds out how (see
    "The Breaker" below);
- **the Impact Scout**, a standing survey that never argues about the fix. It maps *what
  else has to move* for any fix to be complete. See "The Impact Scout" below.

Each standing seat covers a different way a fix fails. The Reproducer answers "is this the
real bug?", the Breaker "is the fix correct?", and the scout "is the fix complete?".

A single agent tends to fix the first mechanism it finds, at the first place it finds it.
The council exists to put **real tension** on that choice before any code is written:
three reviewers who would each, left alone, fix it differently. The value is in the
disagreement, so the perspectives must be chosen *for this issue*. A generic
"architect / tester / UX" trio produces three polite agreements.

## Choosing the three

Ask: *which different people would argue about this fix?* Pick three whose instincts
genuinely conflict here. Starting points by issue shape:

| Issue shape | A useful trio |
|---|---|
| UI bug ("the button does nothing", "text overflows") | **Reporter's advocate** (what they actually wanted) · **Component owner** (where the rule should live, reuse) · **Regression hunter** (every other screen that shares this code) |
| Data or logic bug (wrong totals, bad parsing) | **Root-cause purist** (fix the invariant at its source) · **Blast-radius minimiser** (smallest safe change; who else consumes this) · **Test designer** (what property pins it forever) |
| Feature request | **Product voice** (the reporter's job-to-be-done, discoverability) · **Minimalist** (the smallest thing that satisfies it; what NOT to build) · **Maintainer** (API/settings surface, migration, cost to support forever) |
| Config, environment or integration ("doesn't work with X") | **Compatibility engineer** (other setups this must keep working in) · **Reporter's advocate** · **Defaults skeptic** (auto-detect vs. a setting vs. a command) |
| Performance | **Profiler** (measure first; where the time really goes) · **Simplicity advocate** (algorithmic fix vs. caching) · **Correctness guard** (what the optimisation could break) |
| Security or privacy | **Attacker** (how else it's reachable) · **Least-change maintainer** · **User-trust voice** (what users are told, and what data moves) |

Adapt freely. Name each perspective in a few words and give it one sentence of
*mandate*: what it cares about more than anything.

## Spawning them

Send **one message with six `Agent` calls**, so they all run concurrently:

| Seat | `subagent_type` | Brief |
|---|---|---|
| 3 × chosen perspective | `Plan` (read-only) | the brief below, with a perspective block |
| the Reproducer | `general-purpose` (it runs code, in scratch only) | the brief below, with the Reproducer's seat block instead of a perspective |
| the Breaker | `Plan` (read-only) | the brief below, with the Breaker's seat block instead of a perspective |
| the Impact Scout | `Explore` (read-only) | the brief below, with the scout's seat block instead of a perspective |

Every seat gets the same brief, with only the last block changing:

```
You are one of five councillors deciding how to fix GitHub issue #<n> in <repo> (working
tree: <abs path>, base branch <base>). You are READ-ONLY: explore and verify, don't edit.

## The issue
<title, the report quoted verbatim (trimmed), key comments, what the screenshots show>

## What we know so far
<your explanation from step 3: symptom, mechanism with file:line, candidate fix location>
<repo conventions that constrain the fix: CLAUDE.md rules, test commands, changelog>

## Your perspective: <name>
<one-sentence mandate>. Argue from it. Don't try to be balanced; the other
councillors cover the other angles.

## Deliver (under 350 words)
1. **Recommendation:** the fix in 2–4 sentences, naming the files and functions it touches.
2. **Why this and not the obvious alternative:** name the alternative you reject.
3. **Risks:** what could break, and who else depends on the code you'd change.
4. **The test:** the assertion that pins the rule, not just the symptom.
5. **What the video should show:** the before/after moment that proves it, plus the
   boundary (what deliberately did NOT change).
6. **Confidence:** high / medium / low, with one line on what would change your mind.
Verify claims against the code before making them: cite file:line.
```

Keep it to three chosen perspectives. The two standing councillors aren't more opinions:
they bring evidence (the Reproducer) and attacks (the Breaker), so a fourth chosen
perspective would cost time and add less than either. The scout is a survey, not a
councillor.

## The Reproducer

Every other seat reasons from the code. The Reproducer **runs it**. A council that argues
over a mechanism nobody has seen fail can design a careful fix for the wrong bug. Worse,
the real damage often only surfaces later, while filming. On #161 the stale canvas
writing a deleted file back to disk was only found during the recording, after the fix
had been designed.

It is the only seat that runs code, so it uses `subagent_type: "general-purpose"`, kept to
scratch by its brief. Its worktree **is** the "before" build from step 5.1, so the
evidence costs no extra install. Use this seat block:

```
## Your seat: the Reproducer
Nothing is true until it fails on origin/develop. You don't argue for a fix; you supply
the evidence the others are guessing at. Work ONLY in $SCRATCH/before: never edit the main
checkout, never commit, never push, never comment on GitHub.

1. Set up: `git worktree add "$SCRATCH/before" origin/develop && cd "$SCRATCH/before" &&
   npm ci && npm run build`. This doubles as the BEFORE build for the video, so leave it
   built.
2. Reproduce at the lowest level that shows it: a vitest test (the repo's `vscode` mock
   drives the provider; see `test/unit/semanticEditorProvider.*.test.ts`), else the CLI
   against a fixture, else a scripted sequence of steps. Prefer a test: it becomes the
   fix's first test.
3. Then push further: what ELSE goes wrong in the same state? Data written, lost or
   corrupted; a second panel; undo; a refresh; the physical stage. The worst consequence
   is usually not the one reported.

## Deliver (under 400 words)
1. **Reproduced:** yes / partly / no / already fixed on develop (name the commit).
2. **The failing test:** its path in $SCRATCH/before, the command, and the failure output
   (≤ 15 lines). If not a test, the exact commands and what they printed.
3. **Mechanism:** confirmed as briefed, or corrected, with file:line.
4. **Worse than reported:** anything you found beyond the report, with evidence, or
   "nothing found".
5. **The scene to film:** the fixture, the steps in order, and the exact moment the bug
   is visible. This is the BEFORE recording's script.
```

**How its evidence is used:**
- It outranks argument. If it couldn't reproduce the bug, or found a different
  mechanism, the verdict must follow the evidence. A "no" or "already fixed" is a step-3
  stop case: stop and say so (or, unattended, comment and end the run).
- Its failing test moves onto the fix branch as the first test. It must go **red on
  develop and green on the branch**: run it both ways before committing.
- "Worse than reported" findings join the fix, or the PR body's "Deliberately not
  changed" with a reason.
- Its scene to film becomes the BEFORE half of `record.sh`. If it reproduced the bug in a
  test but couldn't film it, say so before step 6.

## The Breaker

The chosen perspectives each argue for a fix, and the scout checks that the fix is
complete. Nobody is checking that it's **correct**: what the fix itself breaks in the
states nobody thought about. The Breaker writes the pre-mortem. Use `subagent_type:
"Plan"` with this seat block:

```
## Your seat: the Breaker
Assume the fix described in "What we know so far" (or the most likely variant) shipped,
and within a week a user reports that it broke something. Your job is to find out what.
You don't propose the fix. You attack it. Cite file:line for every claim.

Attack it in this repo's known failure states, and say "survives" or "breaks" for each one
that applies (skip only the ones that can't reach this code, and say why):
- undo/redo: the toolbar `undo`, and native Cmd+Z through `flushUndoRedo` and
  `editedTablePaths`;
- the physical stage and its message allowlist; two panels on the same domain; a
  `retainContextWhenHidden` panel that wakes up later;
- watchers and `ownWrites`: our own save racing an external one; a git checkout that
  deletes then restores a file; a burst of events;
- a dirty (unsaved) document; `applyEdit` rejected; `save()` resolving false;
- names differing only in case; Windows paths and separators; a nested dbt project;
- old shapes: v4 domains, a flat vs layer-folder model library, relationships in the
  domain file vs the library, a YAML alias, a file written by 1.6.7;
- the twins: the CLI, `mcp-server/`, and core's `loadDisplaySubjectArea` (the Confluence app);
- scale: a large library, or a slow manifest parse.

## Deliver (under 400 words)
A table of the scenarios that BREAK or are UNSURE, worst first:
| Scenario | What the user sees | Where (file:line) | The test that would catch it |
Then one line: "Most likely real break:". Don't list everything that survives: a short,
sharp list beats a long safe one. Mark anything you couldn't verify "unverified".
```

**Keep the Breaker alive**, like the scout. After implementing, `SendMessage` it the actual
diff (`git diff origin/<base>...HEAD`, not just the stat) and ask it to attack **the code
that was written**. Every scenario it raises ends as one of three things: fixed with a
test, shown to survive (say how), or flagged for Liam in the PR body. See SKILL.md step 5.

## The Impact Scout

A councillor asks "what is the right fix?". The scout asks **"if we make a fix here, what
else in this repo is now wrong, stale or incomplete?"** Single-agent fixes in this repo
usually fail on the ripple, not the root cause:
- a `SCHEMA_CONTENT` change with no `HARNESS_VERSION` bump;
- a new message with no physical-stage decision;
- a renderer field the Confluence viewer meets absent;
- the same bug left in the CLI's twin of the code path;
- a README still describing the old behaviour.

Spawn it with `subagent_type: "Explore"`, which is read-only and built for wide sweeps.
Give it the same issue brief as the councillors, but **not** a perspective block. Use this
instead:

```
## Your seat: Impact Scout
You do not recommend a fix. Assume the fix lands roughly where "What we know so far" says
(and note where the councillors might plausibly put it instead). Your job is to find every
OTHER place in this repo that must change, or must be checked, for that fix to be complete
and consistent. Search wide; read narrowly. Cite file:line for every claim.

Work through ALL of these lenses, and say "nothing found" for a lens rather than skipping it:

1. Same bug, elsewhere. The mechanism you were given: grep for the same pattern (the
   same call, the same assumption, copy-pasted logic) in sibling code. List every other
   instance and say whether it is the same bug.
2. Consumers of what changes. Every caller, importer, subscriber or reader of the
   function, type, message, setting, file format or CLI output the fix will touch,
   including tests, the webview, the CLI, the MCP server, and both packages.
3. Twin implementations. This repo deliberately has several hosts for one behaviour: the
   canvas vs the `erd-studio` CLI vs `mcp-server/` vs `@erd-studio/core`'s
   `loadDisplaySubjectArea` (the Confluence app), and the logical vs physical stage. Does each
   twin need the same fix, or does it deliberately differ?
4. Contracts and versioned artefacts. Read `.claude/skills/issue-to-pr/references/ripple-map.md`
   and walk every row whose trigger matches. Report [convention] rows first: no test
   catches those.
5. Old data and other versions. Files written by older or newer extension versions
   (still read? still render?), a cached `DisplaySubjectArea` from an older core, a user
   mid-upgrade, a teammate on 1.6.7 who rewrites the same file.
6. Tests that encode the old behaviour. Which existing tests or goldens will now fail,
   or worse, keep passing while asserting something that is no longer true?
7. User-facing words. README, CHANGELOG, `CLAUDE.md`, `docs/`, the walkthrough, Getting
   Started copy, the setup skill (`src/harness/**`), `SCHEMA_CONTENT`, error and toast
   text, command titles. Anything that describes the behaviour being changed.
8. Adjacent requests. Open issues touching the same area
   (`gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --jq '.[] | "\(.number) \(.title)"'`):
   would this fix resolve, conflict with, or make harder another open issue?

## Deliver (under 500 words)
A table: | Item | Where (file:line) | Must change / Check / Leave alone | Why | Caught by CI? |
Must-change items first. Then one line: "Highest-risk miss:" the item most likely to be
forgotten. Do not pad. A short honest list beats a long speculative one; mark anything
you could not verify as "unverified".
```

The scout's table is a **plan input, not a verdict**. Its must-change rows join the
implementation plan, its check rows become your post-implementation audit, and "leave
alone" rows with a reason go into the PR's "Deliberately not changed".

**Keep the scout alive.** After implementing, `SendMessage` the scout with `git diff
origin/<base>...HEAD --stat` and the list of changed symbols, and ask it to re-walk its
table against what was *actually* built: what's still missing, and what the diff touched
that the plan didn't predict. The council debated a fix, and the diff is what shipped, so
this second pass catches the drift between them. See SKILL.md step 5.

## Synthesising

You are the chair, not a vote-counter. Weigh the arguments, not the headcount:

1. **Start from the Reproducer's evidence.** It decides what the bug *is*. If it
   couldn't reproduce it or found a different mechanism, re-read the other four in that
   light. An argument for fixing a mechanism that didn't fail doesn't count.
2. Put the three chosen recommendations side by side. Where they **agree**, that's
   settled. Where they **disagree**, decide on the merits. Correctness beats convenience. The
   reporter's actual need beats the literal request. A smaller change beats a larger one
   when both fully solve it. And no surprise settings, migrations or API changes unless the
   issue requires them.
3. **Run the verdict past the Breaker's table.** Every "breaks" scenario that reaches the
   chosen fix must be designed out or given a test now, not discovered in the diff.
4. Take the best **test** and the best **video moment** from whoever proposed them. The
   Reproducer's failing test and scene to film are the default. Use another councillor's
   only when it pins the rule better.
5. Check the verdict against the repo's conventions from step 3.

Show it in the chat, compactly:

```
**Council** — #<n>
| Councillor | Recommends | Key risk raised |
|---|---|---|
| Reporter's advocate | … | … |
| Minimalist | … | … |
| Maintainer | … | … |
| Reproducer | reproduced: yes/partly/no · <the failing test> | <worse than reported> |
| Breaker | — | <most likely real break> |

**Verdict:** <the fix, 1–3 sentences>. **Why:** <one line>. **Overrode:** <dissent you set
aside, and why>.

**Ripple** (Impact Scout): <n> must-change, <n> to check. <one line naming the
must-change items, e.g. "bump HARNESS_VERSION + regen fixture harness, update the
reference doc, same bug in src/cli/diff.ts:88">
```

**Ask the user only when the split is about product direction:**
- a new setting versus a changed default;
- a new command versus a UI button;
- changing documented behaviour.

Present the two options with the council's arguments, and recommend one. Implementation
disagreements are yours to settle. The dissent note in the PR body tells the reviewer what
was considered.
