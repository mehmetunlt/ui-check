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
- `console`, `network`, `response`, `cookies`, `storage` and `a11y` inspect the page like the browser devtools.
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
