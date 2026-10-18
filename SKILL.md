---
name: ui-check
description: Use for ANY browser check of a web app, in any project (local dev server, staging, a live site) - after UI changes land, to confirm a fix in the real app, to click through pages, fill forms, sign in, check phone width or dark mode, or look for errors. Runs `ui-check` in Bash - scripted steps in one hidden Chrome, judged by a fast image classifier - instead of the Playwright or Chrome DevTools MCP browser tools, which are slow and costly. Use those MCPs only for what ui-check cannot do.
---

# ui-check: cheap, fast browser checks

`ui-check` drives one Chrome with a list of steps and prints one line per step. No model
reads the page between steps; a fast classifier (jev-1.14 with images, about 0.4 s and $0.0001 a
question) looks at the screenshot only where a step needs a judgment. A ten-step walk takes
seconds and well under a cent, against minutes and many thousands of context tokens with the
browser MCPs.

**Default for every browser check**, including drag and drop, uploads, dialogs, performance,
memory and Lighthouse. Reach for the Chrome DevTools MCP only for what ui-check has no step for
(network or CPU throttling, breakpoints, live CSS editing) or when the user asks for it by name.

## Run it

```sh
ui-check --base http://localhost:3000 \
  open /login fill Email me@example.test fill Password 'secret-pass-1' click 'Sign in' \
  wait 2 look see 'the dashboard with a list of projects' \
  click 'the settings link in the sidebar' see 'a settings page' phone look dark look
```

Run `ui-check --help` for the whole list. The main steps:

- `open PATH|URL`: PATH is joined to `--base` (or `UI_CHECK_BASE`; default `http://localhost:5173`). Always pass `--base` outside agents-system.
- `click TEXT`, `hover TEXT`, `fill FIELD VALUE`, `select FIELD OPTION`: by accessible name, label, placeholder or text first; `css=…` or `role=…` selectors pass through. When nothing matches, the classifier picks the visible control the words describe, so `click "the send button"` or `fill "the search box" x` works on icon-only buttons and unlabeled fields. The line says how it matched (`name`, `text`, `picked "Send" p 0.92`).
- `see CLAIM` / `nosee CLAIM`: the classifier checks the screenshot (and visible text) for CLAIM; prints `p`; fails when wrong. Write claims about what a person would see: `see "the thread shows a reply from the agent"`.
- `look`: health check of the screen: an error screen fails; blank, stuck loading or broken layout warn.
- `wait SECONDS|TEXT`, `press KEY`, `scroll down|up|TEXT`, `phone`, `desktop`, `dark`, `light`, `back`, `reload`.
- `drag FROM TO`: drags one element onto another (HTML5 drag and drop works); each is found as `click` finds it, or by its text.
- `upload TARGET FILE`: into the file field TARGET names, or through the picker the control TARGET opens (a hidden input works); falls back to the page's first file input.
- `dialog accept|dismiss|TEXT`: how alert, confirm and prompt dialogs are answered from that step on (TEXT answers a prompt). Without it every dialog is dismissed, so a "Delete everything?" confirm never goes through by accident. Each dialog prints an `info` line.
- `read` prints the visible text (2,000 characters); `eval JS` prints a value; `shot` saves a screenshot and prints its path.
- Inspecting, like the browser devtools (all of it from the current run, so put these steps after the actions they are about):
  - `console`: every console message and page error, all levels.
  - `network FILTER`: requests with method, status, time and type; FILTER is part of the URL, a type (`fetch`, `xhr`, `document`) or a status (`404`, `failed`); `""` for all.
  - `response FILTER`: the latest matching response's status, headers (cookie and auth headers hidden) and body.
  - `cookies` (values never printed), `storage` (localStorage and sessionStorage), `a11y` (the accessibility tree, roles and names).
- Performance and memory:
  - `perf`: TTFB, DOMContentLoaded, load, LCP and CLS, script, layout and style time since the run began, element count, bytes, JS heap.
  - `heap`: garbage-collects, then saves a memory snapshot (`.heapsnapshot`, for the DevTools Memory tab) and prints heap size, DOM nodes and listeners. A second `heap` in the same run prints the change, so `heap` before and after repeating an action is a quick leak check.
  - `trace start` ... `trace stop`: a performance trace (`.json`, for the DevTools Performance panel) of the steps between.
  - `lighthouse`: a Lighthouse audit of the current page (desktop preset, or mobile at `phone` width) with scores, the main metrics, the worst audits and the report path. Takes 20 to 60 s; the first run downloads Lighthouse. The page's storage and sign-in are kept.
- Files (screenshots, snapshots, traces, reports) go to `$TMPDIR/agents-ui-check` and are deleted after a day.
- `--plan FILE`: one step per line, shell quoting, `#` comments. Keep reusable walks in the project.
- Hidden by default: Chrome runs headless and never comes up on the screen. `--show` uses a visible window instead; `--slow` shows it and pauses between steps. Use those only when the user wants to watch. The hidden and visible Chromes keep separate profiles, so each needs its own sign-in.

Every step also reports new page errors (fail), console errors, 5xx responses and refused writes (warn).
The exit code is 1 when a step failed.

## Working rules

- One run per walk; chain the steps in one command. Runs continue where the last left off (same tab, same page), so a follow-up run can start without `open`.
- Read a screenshot only when a step FAILs or a `look` warns: the failing line prints its path. Never take screenshots just to look.
- Chrome stays open between runs with its own profile under `~/.cache/agents-ui-check` (sign-ins are kept). Leave it open while testing in succession; run `ui-check --close` when done for a while. It stops only the Chromes it started (by PID).
- `see` answers are a fast judgment, not proof. When a FAIL looks wrong, open the screenshot before concluding, and rephrase the claim to be concrete.
- Never sign in with a real person's account or submit anything that sends mail, money or messages outside a test setup.

## Setup facts

Standalone: `~/.local/bin/ui-check` runs `~/.local/share/ui-check/ui-check.mjs` (one bundled file plus playwright-core and @napi-rs/canvas beside it) with the system Google Chrome, reading `OPENROUTER_API_KEY` from `~/.config/ui-check/env`. It needs nothing from any project. If the key is missing, `see` fails and `look` is skipped; the rest still works. Source: the private `mehmetunlt/ui-check` repo (checkout `~/ui-check`); `npm run install:global` there rebuilds and reinstalls it.
