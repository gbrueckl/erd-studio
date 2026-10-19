# The video: storyboard, narration, render

Read this at step 6, after recording. `scripts/make_video.py` turns one `storyboard.json`
into the final MP4. Everything else (voice, captions, music, fades, size cap and contact
sheet) is automatic.

```bash
uv run --quiet --script "$S/make_video.py" storyboard.json --plan   # voice + timeline only
uv run --quiet --script "$S/make_video.py" storyboard.json          # render
uv run --quiet --script "$S/make_video.py" --say "Test line" -o x.wav   # audition a phrasing
```

`uv` reads the dependencies from the script header (`kokoro-onnx`, `soundfile`, `numpy`,
Python 3.10–3.12), so there's nothing to install. The voice clips are cached by text,
which makes re-renders after a wording tweak fast.

## Standard structure

| # | Segment | Content |
|---|---|---|
| 1 | `card` | Title `<Project> · Issue #<n>`, subtitle = the issue in a few plain words, note `Reported by @<login>`, spoken intro |
| 2 | `card` | `BEFORE`, `accent: red`, subtitle `<base branch> · v<version>` |
| 3 | `clip` | the BEFORE recording, `tag: "BEFORE · <base>"` |
| 4 | `card` | `AFTER`, `accent: green`, subtitle `this pull request` |
| 5 | `clip` | the AFTER recording, `tag: "AFTER · this PR"` |
| 6 | `term` | *(optional)* the new test passing, or the CLI output after the fix |
| 7 | `card` | `Fixed in PR #<n>` (or `Fix ready for review`), with 2–3 `bullets`, spoken summary |

Aim for 45–90 seconds in total. The render caps the file at 9.5 MB, below GitHub's 10 MB
video upload limit on free plans, by re-encoding at a computed bitrate when it needs to.

## Schema

```jsonc
{
  "output": "issue-82-before-after.mp4",   // relative to the storyboard's folder
  "width": 1920, "height": 1080,           // optional; default = first clip's size, max 1920 wide
  "music": "auto",                         // "auto" (bundled track), "none", or a path
  "music_volume": 0.9, "duck": 0.4,        // bed level, and how far it dips under the voice
  "voice": "af_heart", "speed": 1.0, "max_speed": 1.15, "voice_gain": 2.0,
  "max_mb": 9.5,
  "segments": [
    {"type": "card", "title": "…", "subtitle": "…", "note": "…", "accent": "red|green|blue",
     "bullets": ["…", "…"], "duration": 3.5, "say": "spoken while the card shows"},

    {"type": "clip", "src": "rec/before",          // a recorder dir, a video file, or an image
     "tag": "BEFORE · main", "trim": [0.0, 32.0],  // optional, in seconds of the source
     "cues": [                                     // optional: omit to use rec/before/marks.jsonl
       {"at": 1.2, "caption": "The sidebar shows `No diagrams yet`.",
        "say": "The sidebar shows no diagrams."}   // say defaults to the caption; "" = silent caption
     ]},

    {"type": "term", "title": "$ npm test", "file": "tests.txt",   // or "text": "…"
     "tag": "AFTER", "duration": 4, "say": "And the new test passes."}
  ]
}
```

### How timing works

- A **card** or **term** lasts `max(duration, narration + about 1.2 s)`.
- In a **clip**, each cue starts its caption *and* its narration at `at`. The caption stays
  until the next cue.
- If a line is longer than the gap before the next cue, it is first **sped up** (to at most
  `max_speed`). If it still doesn't fit, the clip **freezes on the frame just before the
  next cue** until the line ends. Narration is never cut off and never overlaps.
- `--plan` prints every placement with `HOLD +Ns` where a freeze was needed, and warns on
  any freeze over 2 s. **Shorten those lines**, because a clip that keeps freezing looks
  broken.
- Without `cues`, a recorder directory's `marks.jsonl` supplies them (caption = spoken
  text = the mark). Add `cues` only to override wording, drop a mark, or give a caption a
  different spoken form. `--plan` shows the times the marks resolve to, so copy those.

## Writing the narration

The voice is **Kokoro-82M `af_heart`**, a warm American-English female voice and the
highest-rated voice in the Kokoro set. Write for the ear:

- **One idea per line, at most about 12 words.** Captions and speech share a window, and
  two short lines beat one long one.
- **Say what it means, not what it is.** Write "It opened the first dbt project, so there
  are no diagrams", not "The sidebar view".
- **Spoken forms:**
  - numbers: "issue eighty-two", "pull request eighty-three" (`#82` gets read as "hash
    eighty-two");
  - acronyms it might garble: `"D B T"`, `"E R D"`, `"S Q L"`;
  - paths and identifiers: say them in words, and keep the literal form in the caption.
- **Captions may use backticks** for identifiers (``Select dbt Project…`` renders
  monospace, in amber). Backticks are stripped from speech automatically.
- **Audition** anything you're unsure of with `--say` before rendering.
- **Keep the tone plain.** State what happens. Skip "Amazing!", "Simply…" and sign-offs.

## Checking the render

The render prints the video path, a **contact sheet** (`<name>-sheet.jpg`, one still per
caption and card) and `<name>.timeline.json`. Read the sheet and check:

- every caption is true of its picture (the fix is visible where the caption claims it);
- the BEFORE clip really shows the defect and the AFTER clip really shows it gone;
- nothing private is visible (see `recording.md`);
- the badge matches the side: red BEFORE, green AFTER.

Levels are fixed rather than measured per run. Speech sits around -17 dB RMS and the music
bed around -26 dB, ducking about 8 dB under the voice. Peaks stay at or below -2 dBFS.
Only change `music_volume`, `duck` or `voice_gain` if the developer asks.

## The voice and the music: where they come from

- **Voice.** `af_heart` is a style vector inside Kokoro's `voices-v1.0.bin`. It isn't an
  audio file, so it can't be "saved" as one; it is regenerated from text each run.
  - On first use the script downloads `kokoro-v1.0.int8.onnx` (88 MB) and
    `voices-v1.0.bin` (28 MB) from the
    [kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
    into `${ISSUE_TO_PR_CACHE:-~/.cache/issue-to-pr}/kokoro`, and reuses them afterwards.
  - For the full-precision model (310 MB, marginally cleaner), set
    `KOKORO_MODEL=kokoro-v1.0.onnx`.
  - The model is [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), under the
    Apache-2.0 licence.
- **Music.** It's bundled in `assets/music/` (see its README) and needs no network access.
  - `"auto"` picks the shortest track that covers the video, and loops the longest one if
    none does.
  - It fades in over 1.5 s and out over the last 3 s.
