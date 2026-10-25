# ui-check

Scripted browser checks of any web app in one persistent Chrome, judged by a fast image classifier
(jev-1.14 on the screenshot, about 0.4 s and $0.0001 a question). Built so coding agents can check
a UI in seconds without reading whole pages into their context.

```sh
ui-check --base http://localhost:3000 \
  open /login fill Email me@example.test fill Password 'secret-pass-1' click 'Sign in' \
  wait 2 look see 'the dashboard with a list of projects' network fetch console
```

`ui-check --help` lists every step; `SKILL.md` is the guide agents read.

- Chrome runs hidden (headless) and stays open between runs with its own profile, so sign-ins are kept. Each session (`UI_CHECK_SESSION`, else the Claude Code session or calling process, per project) gets its own tab, and its runs take turns on it. `--show` and `--slow` use a visible window; `--close` closes the session's tab and stops Chrome when no other session uses it.
- `see`, `nosee` and `look` ask the classifier about the screenshot. A click or fill whose words match nothing asks it which visible control they mean.
- When several elements match a click or fill, the one in an open dialog, not covered, in view, or the focused form's submit button wins, and the line says which; `click Payouts 2` or `click 'second Payouts'` picks one. `select` also drives custom dropdowns.
- `size 1920x1080` (or `size 1440`, which is 1440x900) sets the viewport, and each device is a name: `phone-small`, `phone`, `phone-large`, `tablet`, `tablet-landscape`, `desktop`, `laptop`, `wide`, `qhd`; phones and tablets turn on touch. Use it for layouts that change at 1500 or 1920 (a sidebar that unfolds, a wide board).
- `console`, `network`, `response`, `cookies`, `storage` and `a11y` inspect the page like the browser devtools; `cookie NAME VALUE` and `clear-cookies [DOMAIN]` change cookies, `eval JS|@FILE` runs expressions or statements (a file's script too), and `ignore TEXT|STATUS` turns expected errors into info lines (`ignore 404` for a dev server's missing fixtures).
- `drag`, `upload` and `dialog` cover drag and drop, file pickers and alert, confirm and prompt dialogs.
- `perf`, `heap` (memory snapshots and leak deltas), `trace start|stop` and `lighthouse` (run on demand with npx, pinned) cover performance and memory.

## Install

```sh
npm install
npm run install:global      # builds dist/ui-check.mjs and installs the command, runtime and skill
echo 'OPENROUTER_API_KEY=...' > ~/.config/ui-check/env && chmod 600 ~/.config/ui-check/env
```

The installed copy (`~/.local/share/ui-check`, `~/.local/bin/ui-check`, `~/.claude/skills/ui-check`)
needs nothing from this checkout. Re-run `npm run install:global` after any change. Needs Node 22+
and Google Chrome.

## Develop

`npm run check -- <steps>` runs from source; `npm test`; `npm run typecheck`. `src/browser.test.ts` drives a Chrome of
its own (`UI_CHECK_STATE` and `UI_CHECK_PORT` point a run at another profile and port) over pages it serves.

`src/classifier`, `src/models`, `src/look-image.ts` and `src/png.ts` are copied from the agents-system
repo (its decisions client, cost tracking and screenshot fitting), trimmed to what this needs.
