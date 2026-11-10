# Showcase video, 10 Nov 2026: the agent places a WhatsApp call

One composition, two cuts: 1080 x 1920 (9:16) and 1920 x 1080 (16:9). Same look as the posters next door (`../posters/posters.css`, theme iris): the brand line, the thin phone bezel with a drawn status bar, Roboto Flex from `apps/desktop/src/renderer/fonts`, colours from `apps/desktop/src/shared/brand.ts`.

## Files

- `comp.html`: the whole frame as a pure function of time. `setup(spec, format)` lays it out, `renderAt(t)` draws second `t`. No CSS transitions, so every frame is the same on every run.
- `render.mjs`: opens `comp.html` in headless Chromium, steps through the frames and pipes them to ffmpeg (H.264, AAC, fast start).
- `edit.json`: the edit of the real take: cut list, chapter captions, transcript lines with their times, privacy overlays, audio tracks.
- `edit.dryrun.json`: the same with stand-in footage (two poster stills), to judge the look without a take.
- `recorder.js`: runs in the WhatsApp Web page before the call and records both voices (screen recordings on Android carry no call audio).

## Render

```
# footage to frames, 30 a second
ffmpeg -i take.mp4 -vf fps=30 -q:v 2 work/frames/%05d.jpg
# one cut
node render.mjs --spec edit.json --format 9x16 --out out/call-9x16.mp4 --pw <folder with node_modules/playwright-core>
# one frame, to look at
node render.mjs --spec edit.json --format 16x9 --still 12.5 --png out/still.png --pw <folder>
```

Needs Node 20 or newer, playwright-core with its Chromium, and ffmpeg.

## The spec

- `source`: frames folder, frames a second, frame count, size, and `crop.top`: the phone's own status bar is cut off and a clean one is drawn, so no notification icon can show.
- `segments`: `{out, src, len, speed}`: from output second `out`, show the footage from source second `src` for `len` seconds. Dead time is cut here.
- `chapters`: the caption on screen from second `t`: a small `step` line and the `text` line, or an `ask` typed out as a message.
- `sheet` and `lines`: the transcript sheet and each line's start `t` and `dur` (words appear across `dur`).
- `blurs`: privacy overlays in source pixels, alive between source seconds `s0` and `s1`. `cover` paints a flat colour instead of a blur.
- `audio`: files placed at output second `at` (`start`, `end`, `gain`).

Raw recordings, frames and renders live in `work/` and `out/`, which are not committed.
