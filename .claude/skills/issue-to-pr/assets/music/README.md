# Background music

| File | Length | Character |
|---|---|---|
| `build-134s.mp3` | 2:14 | ambient-electronic underscore that builds; "NFS demo music — part 2 (build)" |

The track is Liam Wynne's own. It was synthesised procedurally with numpy/scipy, so there
are no third-party rights in it. The source files are kept outside this repo:
- `synth_music.py` and `synth_music2.py`, the generators (`synth_music.py` seeds its RNG,
  so it re-renders identically);
- `music.wav`, a rendered WAV;
- `NFS demo music - part 1 (calm, 200s).mp3` and `… part 2 (build, 134s).mp3`.

It's bundled here, rather than fetched or regenerated per run, because a 1.6 MB file is
cheaper than a Drive round-trip, and cheaper than a scipy install plus a synthesis run.
It was re-encoded from the 320 kb/s original to 96 kb/s: it sits ducked under
narration, and the saving keeps the plugin small.

To add a track, drop an `.mp3` here. `make_video.py`'s `"music": "auto"` picks the shortest
track that covers the video, and loops the longest one if none does. The calm 200 s part 1
is the obvious next addition, for videos over 2:14:

```bash
ffmpeg -i "NFS demo music - part 1 (calm, 200s).mp3" -b:a 96k calm-200s.mp3
```
