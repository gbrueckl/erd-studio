# Telemetry triage routine

Instructions for the scheduled Claude Code routine **ERD Studio telemetry triage** (Tuesdays and Thursdays, 08:50 Sydney). The routine's own prompt only says to read this file from `origin/develop` and follow it, so changes here are reviewed like code and take effect on the next run after they reach `develop`.

You are the ERD Studio telemetry triage job. Goal: find every genuine problem real users hit on the CURRENT release and raise one well-evidenced GitHub issue per NEW problem in liam-machine/erd-studio, however few installs or occurrences it has. Never raise something already fixed (released or unreleased) or already raised. When the telemetry cannot tell you whether something is a real bug, or its root cause, improve the telemetry so a later run can (REFLECT). The only code this job changes is telemetry instrumentation, in a PR into develop. Never fix bugs yourself, never merge.

Check out liam-machine/erd-studio (clone if needed) and run `git fetch origin main develop`.

STEP 0 - MEMORY FROM EARLIER RUNS (first)
Runs share no memory except GitHub. List OPEN issues and PRs labelled `telemetry-gap` (marker `<!-- telemetry-gap: <code> -->`). For each gap issue:
- Instrumentation PR still open, or merged but not yet in a released version -> note in the summary, add nothing for that code.
- Released -> query its new keys on that version or later. Cause now clear: raise the real issue (linking the gap) and close the gap with a comment. Shown benign: comment why, close. Still ambiguous: comment what the data showed and REFLECT again for a sharper split, linked from the same gap issue. No data yet: comment only once it has been released 14+ days, and say in the summary whether to keep waiting.

DATA
- Cloudflare D1 'erd-studio-telemetry' (id 58f599b8-709f-47bf-9164-057cfdd06050), table `heartbeats` (one row per install per UTC day; schema in telemetry/schema.sql; `errors` / `features` are JSON objects, use json_each). Use the Cloudflare connector's D1 query tool (ToolSearch 'cloudflare d1'). If unavailable or unauthorised, stop and say so; never guess at data. Keep queries small (D1 rejects large UNIONs).
- Always COALESCE(dev,0)=0. Last 14 days (widen for one code if you need history).
- Privacy: aggregates only. Never output install_id or raw rows. Never show a count below 2 next to an os+host+version combination; say 'one install' without that detail instead. Count installs with COUNT(DISTINCT install_id).
- Meaning of a code: src/services/telemetryPayload.ts (ERROR_CODES + comments), then grep `telemetry.error('<code>')` and helpers (domainLoadErrorCode, modelFileErrorCode, manifestFailureCode). `manifestMissing` is retired; ignore it.

VERSION RULES
1. Latest released = newest versioned heading in CHANGELOG.md on origin/main. Also read develop's `## Unreleased` and PRs merged into develop since: fixed but not shipped.
2. Per code: installs and occurrences per ext_version (compare versions numerically).
3. Candidate only if it occurs on the latest released version or newer. Older-only -> summary as fixed/superseded (note if the latest version has under 10 active installs: weak evidence).
4. Already handled? Search open and closed issues for `telemetry-code: <code>`, the code name and symptom, plus open gap issues; and develop's merged PRs / Unreleased notes. Open issue exists -> comment only if more installs or a newer version. Fixed but unreleased -> skip, note it. Closed as fixed in V but seen on V or later -> new 'Regression: ...' issue linking the old one.

WHAT TO RAISE - NO THRESHOLD, NO CAP
Frequency never decides: a genuine problem seen once on one install is raised. Counts are evidence and set the ranking only. No limit on issues per run. Investigate every candidate: trace the recording site, read the logic, check which features co-occur on the same install-days (aggregated), and form a hypothesis with file:line references. Classify:
- (a) Extension bug (domainLoadInternal, saveFailed, layoutFailed, any *Failed, relInv*, relHandlerFailed, editRejected, manifestTimeout, ...): any occurrence on the latest version is genuine. Raise it (bug), or REFLECT if you cannot tell what failed.
- (b) User-environment error (broken model YAML, invalid projectPath, missing diagram file, malformed manifest, invalid domain JSON): a broken user file is not itself a bug. Raise (ux) when the code shows our handling is inadequate: no recovery path, a dead end, a misleading or missing message, data loss, or the same install hitting it again on a later day. Frame as 'users can't recover from X'. Unsure whether handling works -> REFLECT.
- (c) Benign (a cancel, an error the user is told about and recovers from): summary only, with the reason. Not confident it is benign -> REFLECT.

REFLECT - SELF-CHECK BEFORE FINISHING
For every candidate ask: do I know (1) it is a real problem and (2) its root cause well enough for a developer to fix it from my issue? If either is no (a code lumping several failure paths, a site reached from many callers, user mistake vs our bug indistinguishable, nothing in the data separates the hypotheses), it is a TELEMETRY GAP. Also count blind spots found while investigating, e.g. a catch that swallows a failure without recording it. For each gap:
1. State the competing hypotheses and the question that separates them.
2. Design the smallest instrumentation that answers it: split one error code into finer per-path codes (keep the old one as fallback), add a code at an unrecorded failure, or a FEATURES counter for the route taken just before. Follow the contract in CLAUDE.md 'Usage telemetry' and telemetry/README.md: fixed keys, booleans and counts only, never a name, path, message or stack; only something broken is an ERROR_CODE (cancels and routes are FEATURES); append keys at the END of ERROR_CODES / FEATURES in telemetryPayload.ts AND in the same order in telemetry/src/index.js; update telemetry.json; HEARTBEAT_VERSION stays 1; record via the `telemetry` facade, one line per site; CLI/MCP-shared services stay vscode-free (use their callbacks). Add unit tests per new key and a '### Changed' line under `## Unreleased` in CHANGELOG.md. Run npm ci, npm run compile, npm test, and npm test in telemetry/. If you cannot get it green, put the plan on the gap issue instead and say so.
3. ONE instrumentation PR per run for all gaps: branch telemetry-gap/<yyyy-mm-dd> from origin/develop, into develop, labels `telemetry` + `telemetry-gap`; body lists each gap, its hypotheses, the new keys and what each count will tell us.
4. A `telemetry-gap` issue per gap (comment on it if already tracked), first line `<!-- telemetry-gap: <code> -->`, sections: Signal (evidence table) / Why unexplained / Hypotheses / Instrumentation added (PR, keys, first version to carry them) / What the next run should check (exact SQL, and how each result maps to a hypothesis) / Close when. Labels `telemetry`, `telemetry-gap`, `needs-triage`.
If it is clearly a bug but the cause is unclear, raise the bug AND open a gap, linked both ways.

ISSUE FORMAT (rank by installs affected on the latest version)
- Title: plain-language symptom.
- Body line 1: `<!-- telemetry-code: <code> -->` (one per code covered).
- Sections: Summary / Telemetry evidence (version, installs, occurrences, first/last seen; OS and host spread; window; SQL) / What the code means (file:line) / Likely cause (marked hypothesis) / Suggested fix / Acceptance criteria incl. a unit test that would have caught it / Versions affected and not.
- Labels: `telemetry` + `bug` (a) or `ux` (b), plus `auto-fix` ONLY if the cause is clear, the fix local (a few files, no on-disk format or packages/ API change) and testable, else `needs-triage`. Never `issue-to-pr`. Create missing labels.
- End every issue, comment and PR body with:

---
_Generated by [Claude Code](https://claude.ai/code)_

FINISH
Short summary: gap issues followed up and their state; issues opened (links); issues commented on; the instrumentation PR and the gaps it covers; codes skipped with reason (fixed later / fixed unreleased / already raised / benign); telemetry health (no heartbeats in 2 days -> Worker may be down). Nothing new and no gap moved -> one line.
