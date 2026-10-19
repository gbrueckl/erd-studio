#!/usr/bin/env python3
"""issues.py — the GitHub side of /issue-to-pr, deterministic so every run looks the same.

    issues.py list  [--limit 15]          # open issues in the CURRENT repo, newest first
    issues.py brief <n> [--out DIR]       # everything about one issue + downloaded images

`list` ends with a machine-readable line the skill branches on:
    PICK: none            → nothing open; stop
    PICK: auto <n>        → exactly one open issue with no PR yet; take it without asking
    PICK: ask <n,n,...>   → several; ask the user (candidates newest first)

`brief` prints the report, every comment, which PRs/branches already reference the issue
(so you never build a second fix), and downloads each image/video attachment — GitHub's
user-attachments URLs need the gh token on a private repo — so they can be Read.

Every call is REST (`gh api`), never `gh issue` / `gh pr` / `gh repo view`: those use
GraphQL, which the Claude Code cloud sandbox's GitHub proxy refuses with a 403, so a
routine run would die at step 1. The same script therefore works locally and in a routine.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import sys
from datetime import datetime, timezone
from pathlib import Path


def gh(*args: str, optional: bool = False) -> str | None:
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        if optional:
            return None
        msg = r.stderr.strip()
        if "auth" in msg.lower() or "login" in msg.lower():
            msg += "\n→ run `gh auth login` (or `! gh auth login` in Claude Code)"
        sys.exit(f"gh {' '.join(args[:3])} failed:\n{msg}")
    return r.stdout


def rest(path: str) -> list | dict:
    """GET a REST endpoint. Lists are paginated and flattened (one JSON value per line)."""
    out = gh("api", path, "--paginate", "--jq", "if type == \"array\" then .[] | tojson else tojson end")
    rows = [json.loads(line) for line in out.splitlines() if line.strip()]
    return rows if len(rows) != 1 or "?" in path or path.endswith(("/comments", "/branches", "/pulls", "/timeline")) else rows[0]


def repo() -> str:
    if os.environ.get("GH_REPO"):
        return os.environ["GH_REPO"]
    # From the origin remote, with no API call: works for github.com URLs and for the
    # cloud sandbox's proxy remote (…/git/<owner>/<repo>) alike.
    url = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    m = re.search(r"[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", url)
    if not m:
        sys.exit(f"cannot tell the GitHub repo from origin ({url or 'no origin remote'}) — set GH_REPO=owner/name")
    return f"{m.group(1)}/{m.group(2)}"


def age(iso: str) -> str:
    d = datetime.now(timezone.utc) - datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if d.days >= 1:
        return f"{d.days}d ago"
    h = d.seconds // 3600
    return f"{h}h ago" if h else f"{d.seconds // 60}m ago"


_PRS: list[dict] | None = None


def open_prs_mentioning(n: int) -> list[dict]:
    """Open PRs whose title/body reference #n (catches 'Fixes #n', 'Closes #n', '(#n)')."""
    global _PRS
    if _PRS is None:
        _PRS = rest(f"repos/{repo()}/pulls?state=open&per_page=100")
    pat = re.compile(rf"(?<![\w/])#{n}\b")
    return [p for p in _PRS if pat.search(p.get("title", "") + "\n" + (p.get("body") or ""))]


def linked_prs(n: int) -> list[str]:
    """PRs that reference the issue from anywhere (the timeline's cross-references),
    open or merged — the REST stand-in for GraphQL's closedByPullRequestsReferences."""
    out = []
    for e in rest(f"repos/{repo()}/issues/{n}/timeline?per_page=100"):
        src = (e.get("source") or {}).get("issue") or {}
        if e.get("event") == "cross-referenced" and src.get("pull_request") and src.get("state") == "open":
            out.append(src["html_url"])
    return list(dict.fromkeys(out))


def cmd_list(limit: int) -> None:
    name = repo()
    issues = [i for i in rest(f"repos/{name}/issues?state=open&per_page={min(limit, 100)}")
              if "pull_request" not in i][:limit]
    issues.sort(key=lambda i: i["created_at"], reverse=True)
    print(f"# Open issues — {name}\n")
    if not issues:
        print("(none)\n\nPICK: none")
        return
    print("| # | Title | By | Opened | Labels | 💬 | Linked PR |")
    print("|---|---|---|---|---|---|---|")
    free = []
    for i in issues:
        linked = [f"#{p['number']}" for p in open_prs_mentioning(i["number"])]
        if not linked:
            free.append(i["number"])
        labels = ", ".join(l["name"] for l in i["labels"]) or "—"
        title = i["title"].replace("|", "\\|")
        print(f"| {i['number']} | {title} | @{i['user']['login']} | {age(i['created_at'])} | {labels} "
              f"| {i['comments']} | {', '.join(linked) or '—'} |")
    print()
    if len(issues) == 1 and free:
        print(f"PICK: auto {issues[0]['number']}")
    elif len(issues) == 1:
        print(f"PICK: ask {issues[0]['number']}   (the only open issue already has a linked PR)")
    else:
        order = free + [i["number"] for i in issues if i["number"] not in free]
        print(f"PICK: ask {','.join(map(str, order))}   (issues without a linked PR first)")


ATTACH = re.compile(r"(https://(?:github\.com/user-attachments/(?:assets|files)/[\w\-./]+"
                    r"|user-images\.githubusercontent\.com/[\w\-./%]+"
                    r"|private-user-images\.githubusercontent\.com/[\w\-./%?=&]+))")


def download(url: str, dest_dir: Path, token: str | None, idx: int) -> str:
    """curl, not urllib: the asset URL redirects to S3, and urllib forwards the
    Authorization header across that redirect — S3 then answers 400. curl drops it."""
    tmp = dest_dir / f"attachment-{idx:02d}.part"
    auth = ["-H", f"Authorization: token {token}"] if token else []
    r = subprocess.run(["curl", "-sSL", "--fail", *auth,
                        "-o", str(tmp), "-w", "%{content_type}", url], capture_output=True, text=True)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        return f"FAILED ({r.stderr.strip() or r.returncode}) — say so; do not diagnose from the text alone"
    ctype = r.stdout.split(";")[0].strip()
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
           "video/mp4": ".mp4", "video/quicktime": ".mov"}.get(ctype) or Path(url.split("?")[0]).suffix or ".bin"
    p = tmp.with_suffix(ext)
    tmp.rename(p)
    return str(p)


def cmd_brief(n: int, out: Path) -> None:
    name = repo()
    i = rest(f"repos/{name}/issues/{n}")
    comments = rest(f"repos/{name}/issues/{n}/comments?per_page=100")
    print(f"# #{i['number']} {i['title']}\n")
    print(f"- repo: {name}   state: {i['state']}   url: {i['html_url']}")
    print(f"- reporter: @{i['user']['login']}   opened {age(i['created_at'])}")
    print(f"- labels: {', '.join(l['name'] for l in i['labels']) or '—'}")
    mentioned = {p["html_url"]: f"{p['html_url']} (branch {p['head']['ref']})" for p in open_prs_mentioning(n)}
    linked = [u for u in linked_prs(n) if u not in mentioned]
    branches = [b["name"] for b in rest(f"repos/{name}/branches?per_page=100")
                if re.search(rf"(?<!\d){n}(?!\d)", b["name"])]
    if linked or mentioned or branches:
        print("- ⚠ EXISTING WORK — stop and tell the user before building a second fix:")
        for x in linked:
            print(f"    open PR referencing it: {x}")
        for x in mentioned.values():
            print(f"    open PR mentioning #{n}: {x}")
        for x in branches:
            print(f"    branch: {x}")
    else:
        print("- existing work: none (no open PR referencing it, no branch named for it)")
    print(f"\n## Report\n\n{(i['body'] or '(empty)').strip()}\n")
    for c in comments:
        print(f"## Comment — @{c['user']['login']} ({c.get('author_association', '').lower()}), {age(c['created_at'])}\n")
        print((c["body"] or "").strip() + "\n")

    texts = [i["body"] or ""] + [c["body"] or "" for c in comments]
    urls = list(dict.fromkeys(u.rstrip(").,\"'") for t in texts for u in ATTACH.findall(t)))
    if urls:
        out.mkdir(parents=True, exist_ok=True)
        token = (gh("auth", "token", optional=True) or "").strip() or None
        print("## Attachments (Read every image before diagnosing)\n")
        for k, u in enumerate(urls):
            print(f"- {download(u, out, token, k)}   ← {u}")
    else:
        print("## Attachments\n\n(none)")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("list")
    l.add_argument("--limit", type=int, default=15)
    b = sub.add_parser("brief")
    b.add_argument("number", type=lambda s: int(s.lstrip("#").rsplit("/", 1)[-1]))
    b.add_argument("--out", type=Path, default=Path(tempfile.gettempdir()) / "issue-to-pr",
                   help="where attachments go (never inside the repo)")
    a = ap.parse_args()
    if a.cmd == "list":
        cmd_list(a.limit)
    else:
        cmd_brief(a.number, a.out / f"issue-{a.number}")


if __name__ == "__main__":
    main()
