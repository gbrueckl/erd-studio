#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx>=0.4.9", "soundfile>=0.12", "numpy"]
# ///
"""make_video.py — a storyboard JSON in, a narrated + captioned before/after MP4 out.

    uv run --script make_video.py storyboard.json           # render
    uv run --script make_video.py storyboard.json --plan    # voice + timeline only, no render
    uv run --script make_video.py --say "Hello" -o hi.wav   # audition the voice

Everything a run needs is here or fetched once:
  * narration  — Kokoro-82M, voice `af_heart` (American English, female), run locally via
                 kokoro-onnx. The model (~88 MB int8) and voice pack (~28 MB) download once
                 to ${ISSUE_TO_PR_CACHE:-~/.cache/issue-to-pr}/kokoro and are reused.
  * music      — bundled in ../assets/music (looped if the video outruns it), ducked under
                 the voice with a sidechain compressor.
  * captions   — burnt in with libass from one generated .ass file, so a caption and its
                 narration always start on the same frame.

The one timing rule that matters: narration is NEVER cut off or overlapped. If a line is
longer than the gap before the next cue, the voice is first sped up (to `max_speed`), and
if it still does not fit, the video FREEZES on the last frame before the next cue until
the line finishes. So write cues at the moments things happen, and let the script make
room — then read the `--plan` table and shorten any line it had to hold for long.

Storyboard: see references/video.md for the full schema and a worked example.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
MUSIC_DIR = HERE.parent / "assets" / "music"
CACHE = Path(os.environ.get("ISSUE_TO_PR_CACHE", Path.home() / ".cache" / "issue-to-pr"))
KOKORO_DIR = CACHE / "kokoro"
KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_MODEL = os.environ.get("KOKORO_MODEL", "kokoro-v1.0.int8.onnx")  # or kokoro-v1.0.onnx (310 MB)
KOKORO_VOICES = "voices-v1.0.bin"

FPS = 30
GAP = 0.35          # breathing room after each spoken line, seconds
CARD_BG = "0x0f172a"
TERM_BG = "0x0b1020"
MAC = platform.system() == "Darwin"
SANS = "Helvetica Neue" if MAC else "DejaVu Sans"
MONO = "Menlo" if MAC else "DejaVu Sans Mono"

# ASS colours are &HAABBGGRR
TAG_COLOURS = {"BEFORE": "&H002626DC", "AFTER": "&H004AA316"}
TAG_DEFAULT = "&H00EB6325"
ACCENTS = {"red": "&H004444EF", "green": "&H005EC522", "blue": "&H00FAA560", None: "&H00FFFFFF"}


# ----------------------------------------------------------------------------- utilities
def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write(f"\n$ {' '.join(map(str, cmd))[:600]}\n{r.stderr[-3000:]}\n")
        raise SystemExit(f"command failed: {cmd[0]}")
    return r


def run_bytes(cmd: list[str]) -> bytes:
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode(errors="replace")[-2000:])
        raise SystemExit(f"command failed: {cmd[0]}")
    return r.stdout


def ffmpeg(*args: str, cwd: Path | None = None) -> None:
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], cwd=cwd)


def probe_duration(p: Path) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)])
    return float(r.stdout.strip())


def probe_size(p: Path) -> tuple[int, int]:
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height", "-of", "csv=p=0", str(p)])
    w, h = r.stdout.strip().split(",")[:2]
    return int(w), int(h)


def even(n: float) -> int:
    return int(n) // 2 * 2


def ass_time(t: float) -> str:
    t = max(0.0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def ass_text(s: str, mono_tint: bool = True) -> str:
    s = s.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", "\\N")
    if mono_tint:  # `code` spans -> monospace, amber
        s = re.sub(r"`([^`]+)`", lambda m: "{\\fn" + MONO + "\\c&H8AE6FD&}" + m.group(1) + "{\\r}", s)
    return s


# ----------------------------------------------------------------------------- voice
class Voice:
    def __init__(self, voice: str, speed: float, workdir: Path):
        self.voice, self.speed = voice, speed
        self.dir = workdir / "tts"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._k = None

    def _kokoro(self):
        if self._k is None:
            KOKORO_DIR.mkdir(parents=True, exist_ok=True)
            for name in (KOKORO_MODEL, KOKORO_VOICES):
                dest = KOKORO_DIR / name
                if not dest.exists() or dest.stat().st_size < 1_000_000:
                    print(f"  downloading {name} (one-time) → {dest}", file=sys.stderr)
                    tmp = dest.with_suffix(".part")
                    urllib.request.urlretrieve(f"{KOKORO_RELEASE}/{name}", tmp)
                    tmp.rename(dest)
            from kokoro_onnx import Kokoro
            self._k = Kokoro(str(KOKORO_DIR / KOKORO_MODEL), str(KOKORO_DIR / KOKORO_VOICES))
        return self._k

    def say(self, text: str, speed: float | None = None) -> tuple[Path, float]:
        """Synthesise (cached by text+voice+speed). Returns (wav path, seconds)."""
        import soundfile as sf
        speed = round(speed or self.speed, 3)
        key = hashlib.sha1(f"{self.voice}|{speed}|{text}".encode()).hexdigest()[:16]
        out = self.dir / f"{key}.wav"
        if not out.exists():
            samples, sr = self._kokoro().create(text, voice=self.voice, speed=speed, lang="en-us")
            sf.write(out, samples, sr)
        info = sf.info(out)
        return out, info.frames / info.samplerate


# ----------------------------------------------------------------------------- model
@dataclass
class Line:                      # one spoken line placed on the final timeline
    text: str
    wav: Path | None = None
    dur: float = 0.0
    speed: float = 1.0
    at: float = 0.0              # absolute seconds in the final video


@dataclass
class Event:                     # one ASS dialogue event
    start: float
    end: float
    style: str
    text: str


@dataclass
class Piece:                     # one rendered, silent, normalised video file
    path: Path
    dur: float


@dataclass
class Built:
    pieces: list[Piece] = field(default_factory=list)
    lines: list[Line] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    t: float = 0.0               # running clock


# ----------------------------------------------------------------------------- sources
def frames_to_clip(d: Path, out: Path) -> tuple[Path, list[dict]]:
    """A recorder.mjs frame directory (times.txt = `<frame> <epoch-ms>`) → CFR mp4.
    Returns the clip and any marks (marks.jsonl, `{"t": epoch-ms, "text": ...}`) re-based
    to seconds from the first frame."""
    rows = []
    for ln in (d / "times.txt").read_text().splitlines():
        if not ln.strip():
            continue
        p, ms = ln.rsplit(" ", 1)
        fp = Path(p)
        if not fp.is_absolute() or not fp.exists():
            fp = d / Path(p).name
        rows.append((fp, int(ms)))
    if not rows:
        raise SystemExit(f"{d}/times.txt lists no frames")
    t0 = rows[0][1]
    lines = ["ffconcat version 1.0"]
    for i, (fp, ms) in enumerate(rows):
        nxt = rows[i + 1][1] if i + 1 < len(rows) else ms + 100
        lines += [f"file '{fp}'", f"duration {(nxt - ms) / 1000:.3f}"]
    lines.append(f"file '{rows[-1][0]}'")
    lst = out.with_suffix(".ffconcat")
    lst.write_text("\n".join(lines) + "\n")
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(lst), "-fps_mode", "cfr", "-r", str(FPS),
           "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-crf", "14", "-preset", "fast",
           "-pix_fmt", "yuv420p", str(out))
    marks = []
    mf = d / "marks.jsonl"
    if mf.exists():
        for ln in mf.read_text().splitlines():
            if ln.strip():
                m = json.loads(ln)
                marks.append({"at": round((m["t"] - t0) / 1000, 2), "caption": m.get("text", "")})
    return out, marks


# ----------------------------------------------------------------------------- builder
class Builder:
    def __init__(self, sb: dict, sb_dir: Path, workdir: Path, plan_only: bool):
        self.sb, self.dir, self.work, self.plan_only = sb, sb_dir, workdir, plan_only
        self.voice = Voice(sb.get("voice", "af_heart"), float(sb.get("speed", 1.0)), workdir)
        self.max_speed = float(sb.get("max_speed", 1.15))
        self.b = Built()
        self.W, self.H = self._size()
        self.n = 0

    def _src(self, p: str) -> Path:
        q = Path(os.path.expanduser(p))
        return q if q.is_absolute() else (self.dir / q)

    def _size(self) -> tuple[int, int]:
        if "width" in self.sb and "height" in self.sb:
            return even(self.sb["width"]), even(self.sb["height"])
        for seg in self.sb["segments"]:
            if seg.get("type") == "clip":
                src = self._src(seg["src"])
                if src.is_dir():
                    first = sorted(src.glob("*.jp*g")) + sorted(src.glob("*.png"))
                    if first:
                        w, h = probe_size(first[0])
                        break
                else:
                    w, h = probe_size(src)
                    break
        else:
            w, h = 1920, 1080
        if w > 1920:
            h, w = h * 1920 / w, 1920
        return even(w), even(h)

    # --- helpers
    def _next(self, stem: str) -> Path:
        self.n += 1
        return self.work / f"{self.n:02d}-{stem}.mp4"

    def _speak(self, text: str, window: float | None) -> Line:
        """Voice a line; speed up (to max_speed) if a window is given and it overruns."""
        text = text.replace("`", "")  # `code` spans are for the caption, not the voice
        wav, dur = self.voice.say(text)
        speed = self.voice.speed
        if window is not None and dur + GAP > window and window > 0.8:
            speed = min(self.max_speed, self.voice.speed * dur / max(window - GAP, 0.5))
            if speed > self.voice.speed + 0.01:
                wav, dur = self.voice.say(text, speed)
        return Line(text, wav, dur, speed)

    def _solid(self, colour: str, dur: float, stem: str) -> Piece:
        out = self._next(stem)
        if not self.plan_only:
            ffmpeg("-f", "lavfi", "-i", f"color=c={colour}:s={self.W}x{self.H}:r={FPS}:d={dur:.3f}",
                   "-vf", "format=yuv420p,setsar=1", "-c:v", "libx264", "-crf", "18", "-preset", "fast", str(out))
        return Piece(out, dur)

    # --- segment kinds
    def card(self, seg: dict) -> None:
        say = seg.get("say", "")
        line = self._speak(say, None) if say else None
        dur = max(float(seg.get("duration", 3.0)), (line.dur + 0.3 + 0.9) if line else 0)
        start = self.b.t
        self.b.pieces.append(self._solid(CARD_BG, dur, "card"))
        W, H = self.W, self.H
        acc = ACCENTS.get(seg.get("accent"), ACCENTS[None])
        fade = "{\\fad(250,250)}"
        bullets = seg.get("bullets") or []
        title_y = H * (0.30 if bullets else 0.40)
        ev = self.b.events
        if seg.get("title"):
            ev.append(Event(start, start + dur, "CardTitle",
                            fade + f"{{\\an5\\pos({W/2:.0f},{title_y:.0f})\\c{acc}&}}" + ass_text(seg["title"])))
        if seg.get("subtitle"):
            ev.append(Event(start, start + dur, "CardSub",
                            fade + f"{{\\an5\\pos({W/2:.0f},{title_y + H*0.11:.0f})}}" + ass_text(seg["subtitle"])))
        for i, b in enumerate(bullets):
            ev.append(Event(start, start + dur, "CardSub",
                            fade + f"{{\\an4\\pos({W*0.16:.0f},{title_y + H*(0.20 + 0.075*i):.0f})}}• " + ass_text(b)))
        if seg.get("note"):
            ev.append(Event(start, start + dur, "CardNote",
                            fade + f"{{\\an5\\pos({W/2:.0f},{H*0.86:.0f})}}" + ass_text(seg["note"])))
        if line:
            line.at = start + 0.3
            self.b.lines.append(line)
        self.b.plan.append(f"{start:6.1f}s  card  {dur:4.1f}s  {seg.get('title','')!r}"
                           + (f"  voice {line.dur:.1f}s" if line else ""))
        self.b.t += dur

    def term(self, seg: dict) -> None:
        text = seg.get("text") or self._src(seg["file"]).read_text()
        say = seg.get("say", "")
        line = self._speak(say, None) if say else None
        dur = max(float(seg.get("duration", 4.0)), (line.dur + 0.3 + 1.0) if line else 0)
        start = self.b.t
        self.b.pieces.append(self._solid(TERM_BG, dur, "term"))
        W, H = self.W, self.H
        size = H * 0.026
        max_lines = int(H * 0.70 / (size * 1.3))
        rows = text.rstrip("\n").splitlines()[-max_lines:]

        def colour(r: str) -> str:
            if re.search(r"\b(FAIL|FAILED|Error|ERROR|failed)\b|✗|×", r):
                return "{\\c&H7171F8&}"
            if re.search(r"\b(PASS|passed|ok)\b|✓", r):
                return "{\\c&H80DE4A&}"
            return ""
        body = "\\N".join(colour(r) + ass_text(r, False) + "{\\r}" for r in rows)
        fade = "{\\fad(200,200)}"
        if seg.get("title"):
            self.b.events.append(Event(start, start + dur, "CardSub",
                                       fade + f"{{\\an7\\pos({W*0.06:.0f},{H*0.07:.0f})}}" + ass_text(seg["title"])))
        self.b.events.append(Event(start, start + dur, "Term",
                                   fade + f"{{\\an7\\pos({W*0.06:.0f},{H*0.16:.0f})}}" + body))
        self._tag(seg, start, dur)
        if line:
            line.at = start + 0.3
            self.b.lines.append(line)
            if seg.get("caption", True):
                self.b.events.append(Event(line.at, start + dur, "Caption", "{\\fad(120,120)}" + ass_text(say)))
        self.b.plan.append(f"{start:6.1f}s  term  {dur:4.1f}s  {seg.get('title','')!r}"
                           + (f"  voice {line.dur:.1f}s" if line else ""))
        self.b.t += dur

    def _tag(self, seg: dict, start: float, dur: float) -> None:
        tag = seg.get("tag")
        if tag:
            col = next((c for k, c in TAG_COLOURS.items() if tag.upper().startswith(k)), TAG_DEFAULT)
            self.b.events.append(Event(start, start + dur, "Tag",
                                       f"{{\\3c{col}&\\fad(200,200)}}" + ass_text(tag, False)))

    def clip(self, seg: dict) -> None:
        src = self._src(seg["src"])
        marks: list[dict] = []
        if src.is_dir():
            src, marks = frames_to_clip(src, self.work / f"frames-{src.name}.mp4")
        elif src.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
            still = self.work / f"still-{src.stem}.mp4"
            ffmpeg("-loop", "1", "-i", str(src), "-t", str(float(seg.get("duration", 4.0))), "-r", str(FPS),
                   "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-crf", "14", "-preset", "fast",
                   "-pix_fmt", "yuv420p", str(still))
            src = still
        full = probe_duration(src)
        a, bnd = (seg.get("trim") or [0, full])[:2]
        bnd = min(float(bnd), full)
        a = float(a)
        D = bnd - a
        cues = seg.get("cues")
        if cues is None:
            cues = marks
        cues = sorted(({**c, "at": float(c["at"]) - a} for c in cues if a <= float(c["at"]) < bnd),
                      key=lambda c: c["at"])
        # sub-segments between cue points; each gets a freeze if its line overruns
        cuts = [0.0] + [c["at"] for c in cues] + [D]
        holds = [0.0] * (len(cuts) - 1)
        placed: list[tuple[int, dict, Line | None]] = []
        for i, c in enumerate(cues):
            window = cuts[i + 2] - cuts[i + 1]
            say = c.get("say", c.get("caption", ""))
            line = self._speak(say, window) if say else None
            if line and line.dur + GAP > window:
                holds[i + 1] = round(line.dur + GAP - window, 2)
            placed.append((i + 1, c, line))
        start = self.b.t
        # absolute start of every sub-segment after holds
        abs_starts, t = [], start
        for k in range(len(cuts) - 1):
            abs_starts.append(t)
            t += (cuts[k + 1] - cuts[k]) + holds[k]
        total = t - start

        out = self._next("clip")
        if not self.plan_only:
            n = len(cuts) - 1
            W, H = self.W, self.H
            fc = [f"[0:v]trim={a}:{bnd},setpts=PTS-STARTPTS,fps={FPS},"
                  f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                  f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={CARD_BG},setsar=1,format=yuv420p,split={n}"
                  + "".join(f"[s{k}]" for k in range(n))]
            for k in range(n):
                hold = f",tpad=stop_mode=clone:stop_duration={holds[k]}" if holds[k] > 0 else ""
                fc.append(f"[s{k}]trim={cuts[k]}:{cuts[k+1]},setpts=PTS-STARTPTS{hold}[p{k}]")
            fc.append("".join(f"[p{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=0,"
                      f"fade=t=in:st=0:d=0.25,fade=t=out:st={max(total-0.25,0):.3f}:d=0.25[v]")
            ffmpeg("-i", str(src), "-filter_complex", ";".join(fc), "-map", "[v]",
                   "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-r", str(FPS), str(out))
        self.b.pieces.append(Piece(out, total))
        self._tag(seg, start, total)

        self.b.plan.append(f"{start:6.1f}s  clip  {total:4.1f}s  {seg.get('tag','')} {Path(seg['src']).name}"
                           f"  (source {a:.1f}–{bnd:.1f}s, holds +{sum(holds):.1f}s)")
        for idx, (k, c, line) in enumerate(placed):
            at = abs_starts[k]
            end = abs_starts[k + 1] if k + 1 < len(abs_starts) else start + total
            cap = c.get("caption", c.get("say", ""))
            if cap:
                self.b.events.append(Event(at, max(end, at + 1.5) - 0.05, "Caption",
                                           "{\\fad(120,120)}" + ass_text(cap)))
            if line:
                line.at = at + 0.1
                self.b.lines.append(line)
            flag = ""
            if holds[k] > 0:
                flag = f"  HOLD +{holds[k]:.1f}s"
                if holds[k] > 2.0:
                    self.b.warnings.append(f"cue at {c['at']+a:.1f}s in {Path(seg['src']).name} freezes "
                                           f"{holds[k]:.1f}s — shorten: {cap[:60]!r}")
            self.b.plan.append(f"{at:6.1f}s    cue  voice {line.dur if line else 0:4.1f}s"
                               f" @{line.speed if line else 1:.2f}x{flag}  {cap[:70]!r}")
        self.b.t += total

    # --- output
    def ass(self) -> str:
        W, H = self.W, self.H
        cap = round(H * 0.036)
        head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{SANS},{cap},&H00FFFFFF,&H00FFFFFF,&H28140C0A,&H00000000,1,0,0,0,100,100,0,0,3,{round(cap*0.35)},0,2,{round(W*0.12)},{round(W*0.12)},{round(H*0.055)},1
Style: Tag,{SANS},{round(H*0.028)},&H00FFFFFF,&H00FFFFFF,&H002626DC,&H00000000,1,0,0,0,100,100,1.5,0,3,{round(H*0.012)},0,7,{round(W*0.025)},0,{round(H*0.035)},1
Style: CardTitle,{SANS},{round(H*0.075)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: CardSub,{SANS},{round(H*0.040)},&H00E1D5CB,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: CardNote,{SANS},{round(H*0.028)},&H008B7464,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Term,{MONO},{round(H*0.026)},&H00F0E8E2,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
        body = "\n".join(f"Dialogue: 0,{ass_time(e.start)},{ass_time(e.end)},{e.style},,0,0,0,,{e.text}"
                         for e in sorted(self.b.events, key=lambda e: e.start))
        return head + body + "\n"

    def mix(self, total: float, music: Path | None, out: Path) -> None:
        """Voice + ducked music → one 48 kHz stereo WAV, entirely in numpy.

        Not an ffmpeg filter graph, on purpose: amix/sidechaincompress/asetpts silently
        DROPPED ~1 s of audio across a silent gap (every later line landed 1.07 s early —
        found by comparing speech onsets in the voice track against the final file). Here
        each line is written at an exact sample index, so the timeline is what you asked for.
        Static gains, not loudnorm: its dynamic mode pumps the bed up in every pause."""
        import numpy as np
        import soundfile as sf
        SR = 48000
        n = int(round(total * SR))
        voice = np.zeros(n, dtype=np.float32)
        for ln in self.b.lines:
            data, r = sf.read(ln.wav, dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            if r != SR:  # Kokoro speaks at 24 kHz
                data = np.interp(np.arange(0, len(data) * SR / r) * r / SR,
                                 np.arange(len(data)), data).astype(np.float32)
            i = int(round(ln.at * SR))
            m = min(len(data), n - i)
            if m > 0:
                voice[i:i + m] += data[:m]
        voice *= float(self.sb.get("voice_gain", 2.0))
        mixL = voice.copy()
        mixR = voice.copy()
        if music:
            raw = run_bytes(["ffmpeg", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", str(music),
                             "-t", f"{total:.3f}", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"])
            mus = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)[:n]
            mus = np.pad(mus, ((0, n - len(mus)), (0, 0)))
            # control-rate (100 Hz) duck envelope: fast attack, slow release
            hop = SR // 100
            frames = len(voice) // hop + 1
            lvl = np.sqrt(np.add.reduceat(np.pad(voice, (0, frames * hop - len(voice))) ** 2,
                                          np.arange(0, frames * hop, hop)) / hop)
            active = (lvl > 0.01).astype(np.float32)
            duck = float(self.sb.get("duck", 0.4))
            g = np.empty(frames, dtype=np.float32)
            cur = 1.0
            for k in range(frames):
                target = duck if active[k] else 1.0
                coef = 0.35 if target < cur else 0.03   # ~30 ms down, ~330 ms back up
                cur += (target - cur) * coef
                g[k] = cur
            gain = np.repeat(g, hop)[:n] * float(self.sb.get("music_volume", 0.9))
            t = np.arange(n) / SR
            gain *= np.clip(t / 1.5, 0, 1) * np.clip((total - t) / 3.0, 0, 1)  # fade in / out
            mixL += mus[:, 0] * gain
            mixR += mus[:, 1] * gain
        st = np.stack([mixL, mixR], axis=1)
        peak = float(np.abs(st).max()) or 1.0
        if peak > 0.8:  # -2 dBFS: AAC overshoots a ceiling set any closer to full scale
            st *= 0.8 / peak
        sf.write(out, st, SR, subtype="PCM_16")

    def music(self, total: float) -> Path | None:
        m = self.sb.get("music", "auto")
        if m in (None, "none", False):
            return None
        if m != "auto":
            return self._src(m)
        tracks = sorted(MUSIC_DIR.glob("*.mp3"))
        if not tracks:
            return None
        durs = [(probe_duration(t), t) for t in tracks]
        fitting = sorted(d for d in durs if d[0] >= total)
        return (fitting[0] if fitting else max(durs))[1]


def render(sb_path: Path, plan_only: bool) -> None:
    sb = json.loads(sb_path.read_text())
    out = Path(os.path.expanduser(sb.get("output", sb_path.with_suffix(".mp4"))))
    if not out.is_absolute():
        out = sb_path.parent / out
    work = out.parent / f".{out.stem}-work"
    work.mkdir(parents=True, exist_ok=True)
    B = Builder(sb, sb_path.parent, work, plan_only)
    for seg in sb["segments"]:
        kind = seg.get("type", "clip")
        getattr(B, kind)(seg)
    total = B.b.t

    print(f"\n{sb_path.name}: {len(B.b.pieces)} pieces, {len(B.b.lines)} spoken lines, "
          f"{total:.1f}s total, {B.W}x{B.H}\n")
    print("\n".join(B.b.plan))
    for w in B.b.warnings:
        print(f"\n!! {w}")
    if plan_only:
        return

    (work / "subs.ass").write_text(B.ass())
    lst = work / "pieces.txt"
    lst.write_text("".join(f"file '{p.path}'\n" for p in B.b.pieces))
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(work / "base.mp4"))
    music = B.music(total)
    B.mix(total, music, work / "mix.wav")
    max_mb = float(sb.get("max_mb", 9.5))

    def encode(vargs: list[str]) -> None:
        ffmpeg("-i", str(work / "base.mp4"), "-i", str(work / "mix.wav"), "-vf", "ass=subs.ass",
               "-map", "0:v", "-map", "1:a", *vargs, "-pix_fmt", "yuv420p", "-r", str(FPS),
               "-c:a", "aac", "-b:a", "128k", "-t", f"{total:.3f}", "-movflags", "+faststart",
               str(out), cwd=work)

    encode(["-c:v", "libx264", "-preset", "slow", "-crf", "23"])
    size = out.stat().st_size / 1_048_576
    if size > max_mb:
        kbps = int(max_mb * 8 * 1024 * 0.93 / total - 128)
        print(f"\n  {size:.1f} MB > {max_mb} MB — re-encoding at {kbps} kb/s")
        encode(["-c:v", "libx264", "-preset", "slow", "-b:v", f"{kbps}k",
                "-maxrate", f"{int(kbps*1.5)}k", "-bufsize", f"{kbps*2}k"])
        size = out.stat().st_size / 1_048_576

    # contact sheet: one still per caption/card, so the whole video is checked in ONE Read
    marks = sorted({round((e.start + min(e.end, e.start + 2.5)) / 2, 2)
                    for e in B.b.events if e.style in ("Caption", "CardTitle")
                    or (e.style == "Term" and not any(c.style == "Caption" and c.start >= e.start
                                                      and c.end <= e.end for c in B.b.events))})[:15]
    stills = work / "stills"
    shutil.rmtree(stills, ignore_errors=True)
    stills.mkdir()
    for i, t in enumerate(marks):
        ffmpeg("-ss", f"{t}", "-i", str(out), "-frames:v", "1", "-vf", "scale=640:-2", str(stills / f"s{i:02d}.jpg"))
    sheet = out.with_name(out.stem + "-sheet.jpg")
    if marks:
        cols = 3
        rows = -(-len(marks) // cols)
        ffmpeg("-framerate", "1", "-i", str(stills / "s%02d.jpg"),
               "-vf", f"tile={cols}x{rows}:padding=6:margin=6:color=white", "-frames:v", "1", str(sheet))
    (out.with_suffix(".timeline.json")).write_text(json.dumps(
        {"duration": round(total, 2), "lines": [{"at": round(l.at, 2), "dur": round(l.dur, 2),
                                                 "speed": l.speed, "text": l.text} for l in B.b.lines]}, indent=1))
    print(f"\nvideo    {out}  ({size:.1f} MB, {total:.1f}s)")
    print(f"sheet    {sheet}")
    print(f"music    {music.name if music else 'none'}   voice {B.voice.voice}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("storyboard", nargs="?", type=Path)
    ap.add_argument("--plan", action="store_true", help="synthesise the voice and print the timeline; no render")
    ap.add_argument("--say", help="speak one line (to audition the voice)")
    ap.add_argument("-o", "--out", type=Path, default=Path("say.wav"))
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} not found — install it (macOS: brew install ffmpeg)")
    if a.say:
        v = Voice(a.voice, a.speed, a.out.parent.resolve() / ".say-work")
        wav, dur = v.say(a.say)
        shutil.copy(wav, a.out)
        print(f"{a.out}  {dur:.2f}s")
        return
    if not a.storyboard:
        ap.error("give a storyboard.json (or --say)")
    render(a.storyboard.resolve(), a.plan)


if __name__ == "__main__":
    main()
