# Showcase posters, 10 Nov 2026

Eight posters for the Agent app showcase, each as 1080 x 1080 and 1080 x 1350. One template (`posters.css`), one page per poster and size (`pages/`), rendered by `posters.mjs` with headless Chromium at 2x and scaled to 1080 wide.

Every screen is the real UI with an invented demo world (Sam, who runs a small photo studio, and an agent called Nova). Nothing in it is real data.

## Posters

1. Call: "It picks up the phone."
2. Learned apps: "One agent learns it. Every agent can use it."
3. Helpers: "Work happens in the background."
4. Approvals: "Nothing goes out without your yes."
5. Phone and desktop: "One agent. Phone and desktop."
6. Browser: "Watch it work. Take over any time."
7. Talk: "Or just talk to it."
8. Projects: "A chat for every project."

## Render

```
node posters.mjs --pw <folder with node_modules/playwright-core> --out <folder>
```

`--only "Poster 1"` renders one, `--keep2x` also keeps the 2160 wide render, `--feed` adds two sheets of every poster at 400 px wide (how a phone feed shows them).

Posters 2 and 8 show a slide-up sheet over its page. The harness draws a sheet on an empty page, so `posters.mjs` puts two real renders together the way the app shows them: the page under a 50% scrim, the sheet cut from its own render on top. Fonts come from `apps/desktop/src/renderer/fonts`, colours from `apps/desktop/src/shared/brand.ts`.

## Where the stills come from

- `stills/phone`: the phone app's own Compose screens, drawn by `seeds/ShowcaseShotsTest.kt` in the phone repo (Past-da-king/agent, `app/src/test/java/com/past9/phoneaos/`), 390 x 844 at 3x. Run with `seeds/run-phone.sh`.
- `stills/desk`: the desktop renderer on its mock bridge (`?demo=1`), 1440 x 900 at 2x. `seeds/patch-desk.py` puts the demo world into a throwaway clone (never commit that clone), then build the renderer with `vite build --config vite.web.config.ts` and run `seeds/shoot-desk.mjs`.
- `seeds/dump-mark.mjs` reads the app's mark (the title bar logo) out of the built renderer; the path is pasted into `posters.mjs`.
