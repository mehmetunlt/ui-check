/**
 * ui-check: scripted checks of a web app in one persistent Chrome, judged by the fast classifier.
 *
 * The steps (steps.ts, `--help`) run straight through playwright-core over CDP: no model reads the
 * page between steps, so a walk costs seconds and a fraction of a cent, and only one line per step
 * comes back. The classifier (jev-1.14 with images, through the decisions client) is asked only
 * where a step needs a judgment: `see`/`nosee` and the health `look` send the viewport screenshot
 * with the visible text as context, and a click or fill whose words match nothing asks which
 * visible control they mean. Every step also reports new page errors (fail, or warn on a page that
 * loaded and rendered), console errors and failed same-origin requests (warn), less what `ignore`
 * matches; `look` fails on an error screen and warns on a blank or broken one.
 *
 * Chrome keeps running between runs with its own profile under ~/.cache/agents-ui-check, so a
 * sign-in is kept; each session reuses a tab of its own (session.ts). By default it is headless (port 9334), so
 * nothing comes up on the screen; `--show` (and `--slow`) use a visible window instead (port 9333,
 * a profile of its own, so each keeps its own sign-ins). `--close` stops both by the PIDs they
 * wrote, never by pattern. Screenshots go to
 * $TMPDIR/agents-ui-check and their paths are printed (on `shot` and on every failure).
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser, type CDPSession, type Locator, type Page, type Response } from 'playwright-core'
import { createDecisions } from './classifier/client.ts'
import { quickCheck, type QuickQuestion } from './classifier/quick-check.ts'
import type { Decisions } from './classifier/types.ts'
import { fitForLook } from './look-image.ts'
import { settleForLook, trackRequests } from './settle.ts'
import {
  LOOK_QUESTIONS, NEXT_DEV_SELECTORS, SEE_ID, USAGE, bestCandidate, devOverlayStyle, ignoredBy, judgeWithRetry, pageErrorsFail, tidyText, dialogPolicy, lighthouseSummary, candidateText, isSelector, lookFails, lookProblems, parseSteps, pickQuestion, planWords,
  rankMatches, resolveUrl, seeQuestion, seeVerdict, splitOrdinal, stepLabel, type Candidate, type MatchInfo, type Step,
  DEVICES, isDevice,
} from './steps.ts'
import { acquireLock, activeSessions, callerId, listProcs, lockHolder, projectRoot, readRegistry, sessionKey, staleSessions, writeRegistry } from './session.ts'


// UI_CHECK_STATE and UI_CHECK_PORT give the tests a Chrome of their own.
const STATE_DIR = process.env.UI_CHECK_STATE || join(homedir(), '.cache', 'agents-ui-check')
const PORT = Number(process.env.UI_CHECK_PORT) || 9334
type Mode = { port: number; profile: string; pidFile: string; sessions: string; headless: boolean }
const MODES: Record<'shown' | 'hidden', Mode> = {
  shown: { port: PORT - 1, profile: join(STATE_DIR, 'profile'), pidFile: join(STATE_DIR, 'chrome.pid'), sessions: join(STATE_DIR, 'sessions.json'), headless: false },
  hidden: { port: PORT, profile: join(STATE_DIR, 'profile-hidden'), pidFile: join(STATE_DIR, 'chrome-hidden.pid'), sessions: join(STATE_DIR, 'sessions-hidden.json'), headless: true },
}
const SHOTS = join(tmpdir(), 'agents-ui-check')
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p))
const DESKTOP = DEVICES.desktop
const TEXT_CHARS = 4_000
const CLICK_ROLES = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'treeitem'] as const
const FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'] as const

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== '--')
let base = process.env.UI_CHECK_BASE ?? 'http://localhost:5173'
let close = false
let pauseMs = 0
let show = process.env.UI_CHECK_SHOW === '1'
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
  else if (a === '--base') base = argv[++i] ?? base
  else if (a === '--plan') words.push(...planWords(readFileSync(argv[++i] ?? '', 'utf8')))
  else if (a === '--close') close = true
  else if (a === '--slow') { pauseMs = 1_200; show = true }
  else if (a === '--show') show = true
  else words.push(a)
}

// This caller's tab: see session.ts.
const SESSION = sessionKey(callerId(process.env, process.env.UI_CHECK_SESSION || process.env.CLAUDE_CODE_SESSION_ID ? [] : listProcs(), process.pid), projectRoot(process.cwd()))
const tabLock = (m: Mode, key: string) => join(STATE_DIR, 'locks', `${m.headless ? 'hidden' : 'shown'}-${key}.lock`)
const tabLocked = (m: Mode) => (key: string) => lockHolder(tabLock(m, key)) !== null

if (close && words.length === 0) {
  for (const m of [MODES.shown, MODES.hidden]) {
    const tab = (await portUp(m)) && activeSessions(readRegistry(m.sessions), SESSION, Date.now(), tabLocked(m)).length ? await closeOwnTab(m) : false
    await stopUnlessShared(m, tab)
  }
  process.exit(0)
}
const mode = show ? MODES.shown : MODES.hidden
let steps: Step[]
try { steps = parseSteps(words) } catch (e) { console.error((e as Error).message); process.exit(2) }
if (steps.length === 0) { console.log(USAGE); process.exit(2) }

// ── Chrome ───────────────────────────────────────────────────────────────────
async function portUp(m: Mode): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${m.port}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch { return false }
}
const endpointUp = () => portUp(mode)

/**
 * Headless Chrome on a machine with no mouse reports no pointer and no hover, so `(hover: hover)` and
 * `(pointer: fine)` rules never applied in a desktop check. This tells Blink there is a mouse (fine pointer, hover);
 * phones and tablets turn touch on over it (setWindow).
 */
const MOUSE = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'

async function ensureChrome(): Promise<void> {
  if (await endpointUp()) return
  if (!CHROME) throw new Error('no Chrome found (set CHROME_PATH)')
  mkdirSync(mode.profile, { recursive: true })
  const child = spawn(CHROME, [
    `--remote-debugging-port=${mode.port}`, `--user-data-dir=${mode.profile}`, '--no-first-run', '--no-default-browser-check',
    ...(mode.headless ? ['--headless=new', '--hide-scrollbars', '--window-size=1280,800', MOUSE] : ['--window-size=1300,940']), 'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(mode.pidFile, String(child.pid))
  for (let i = 0; i < 50; i++) {
    if (await endpointUp()) return
    await sleep(200)
  }
  throw new Error(`Chrome did not open its debug port ${mode.port}`)
}

/**
 * Stops the mode's Chrome through its debug port (Browser.close), so it works when the pid file is gone or names the
 * launcher's pid; the pid is the fallback for a Chrome whose port no longer answers.
 */
async function stopChrome(m: Mode): Promise<void> {
  const which = m.headless ? 'hidden' : 'visible'
  let stopped = false
  if (await portUp(m)) {
    try {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${m.port}`, { timeout: 5_000 })
      await (await b.newBrowserCDPSession()).send('Browser.close').catch(() => {})
      stopped = true
    } catch {}
  }
  if (!stopped && existsSync(m.pidFile)) {
    const pid = Number(readFileSync(m.pidFile, 'utf8'))
    try { process.kill(pid, 'SIGTERM'); stopped = true } catch {}
  }
  console.log(stopped ? `stopped the ${which} ui-check Chrome` : `no ${which} ui-check Chrome is running`)
  rmSync(m.pidFile, { force: true })
  rmSync(m.sessions, { force: true })
}

/** --close: Chrome stops unless other sessions are using it (a run going, or one in the last minutes). */
async function stopUnlessShared(m: Mode, closedTab: boolean): Promise<void> {
  const others = activeSessions(readRegistry(m.sessions), SESSION, Date.now(), tabLocked(m))
  if (others.length && await portUp(m)) {
    console.log(`${closedTab ? "closed this session's tab; " : ''}left the ${m.headless ? 'hidden' : 'visible'} ui-check Chrome running: ${others.length} other ${others.length === 1 ? 'session uses' : 'sessions use'} it`)
  } else await stopChrome(m)
}

/** --close on its own, while other sessions keep Chrome: just this session's tab goes. */
async function closeOwnTab(m: Mode): Promise<boolean> {
  const entry = readRegistry(m.sessions)[SESSION]
  if (!entry) return false
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${m.port}`, { timeout: 5_000 })
    for (const p of browser.contexts()[0]?.pages() ?? []) if ((await targetId(p).catch(() => '')) === entry.target) await p.close().catch(() => {})
  } catch {}
  await forgetSession(m)
  return true
}

/**
 * Tabs no session owns any more (a run killed mid-way, a session gone) pile up, and connecting attaches to every tab:
 * one hung orphan stalls every session's connect until it times out. Close them first, over Chrome's HTTP endpoint and
 * under the registry lock, so a tab another session is registering is never taken.
 */
async function pruneOrphanTabs(): Promise<void> {
  const base = `http://127.0.0.1:${mode.port}`
  const release = await acquireLock(`${mode.sessions}.lock`, 15_000)
  try {
    const owned = new Set(Object.values(readRegistry(mode.sessions)).map((e) => e.target))
    const list = (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4_000) })).json()) as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>
    const pages = list.filter((t) => t.type === 'page')
    // A frozen tab (its renderer stopped answering) stalls the attach as surely as an orphan does; its session gets a
    // fresh tab on its next run.
    const answers = (t: { webSocketDebuggerUrl?: string }) => new Promise<boolean>((done) => {
      if (!t.webSocketDebuggerUrl) return done(true)
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      const stop = setTimeout(() => { try { ws.close() } catch {} done(false) }, 3_000)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } }))
      ws.onmessage = () => { clearTimeout(stop); try { ws.close() } catch {} done(true) }
      ws.onerror = () => { clearTimeout(stop); done(true) }
    })
    const frozen = (await Promise.all(pages.map(async (t) => ((await answers(t)) ? null : t)))).filter((t): t is (typeof pages)[number] => !!t)
    const orphans = [...pages.filter((t) => !owned.has(t.id)), ...frozen.filter((t) => owned.has(t.id))]
    // Keep one page so Chrome stays up when nothing is registered yet.
    for (const t of orphans.slice(owned.size ? 0 : 1)) await fetch(`${base}/json/close/${t.id}`, { signal: AbortSignal.timeout(3_000) }).catch(() => {})
  } catch {} finally { release() }
}

async function targetId(p: Page): Promise<string> {
  const s = await p.context().newCDPSession(p)
  try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId } finally { await s.detach().catch(() => {}) }
}

/** This session's tab, opened on its first run; other sessions' tabs idle for hours are closed. */
async function sessionPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  const release = await acquireLock(`${mode.sessions}.lock`, 15_000)
  try {
    const reg = readRegistry(mode.sessions)
    const pages = ctx.pages()
    const ids = await Promise.all(pages.map((p) => targetId(p).catch(() => '')))
    const pageOf = (key: string) => { const i = reg[key] ? ids.indexOf(reg[key].target) : -1; return i >= 0 ? pages[i] : undefined }
    const now = Date.now()
    for (const k of staleSessions(reg, SESSION, now, tabLocked(mode))) { await pageOf(k)?.close().catch(() => {}); delete reg[k] }
    for (const k of Object.keys(reg)) if (!pageOf(k)) delete reg[k]
    let page = pageOf(SESSION)
    if (!page) page = await ctx.newPage()
    reg[SESSION] = { target: await targetId(page), used: now, ...(reg[SESSION]?.scheme ? { scheme: reg[SESSION].scheme } : {}) }
    writeRegistry(mode.sessions, reg)
    // Connecting over CDP makes Playwright emulate a light colour scheme on every tab it attaches to, so another
    // session's page would flip to light mid-run (a tester saw the app's theme change between pages). Put each tab
    // back: the scheme its own session chose, else none (the system's).
    for (const p of pages) {
      const key = Object.keys(reg).find((k) => reg[k]!.target === ids[pages.indexOf(p)])
      await Promise.race([p.emulateMedia({ colorScheme: (key && reg[key]!.scheme) || null }), sleep(1_500)]).catch(() => {})
    }
    if (!pages.includes(page)) await page.emulateMedia({ colorScheme: reg[SESSION]?.scheme ?? null }).catch(() => {})
    return page
  } finally { release() }
}

/** A `dark` or `light` step: kept for this session's tab, so another session connecting later puts it back. */
async function rememberScheme(scheme: 'dark' | 'light'): Promise<void> {
  const release = await acquireLock(`${mode.sessions}.lock`, 15_000)
  try {
    const reg = readRegistry(mode.sessions)
    if (reg[SESSION]) { reg[SESSION]!.scheme = scheme; writeRegistry(mode.sessions, reg) }
  } finally { release() }
}

async function forgetSession(m: Mode): Promise<void> {
  const release = await acquireLock(`${m.sessions}.lock`, 15_000)
  try {
    const reg = readRegistry(m.sessions)
    delete reg[SESSION]
    writeRegistry(m.sessions, reg)
  } finally { release() }
}

// ── run state ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
let decisions: Decisions | null = null
let costMicroUsd = 0
let calls = 0
let failures = 0
let warnings = 0
let shotN = 0
// Console and network notes since the last step, with the URL they are about (for ignore).
const pending: Array<{ text: string; url?: string }> = []
const pageErrors: string[] = []
const ignores: string[] = []
// The status of the document this step loaded, if it loaded one.
let stepDoc: number | null = null
// Everything this run saw, for the console and network steps.
const consoleLog: string[] = []
type NetEntry = { method: string; url: string; status: number | 'failed'; ms: number; type: string; response: Response | null; error?: string }
const netLog: NetEntry[] = []
const NET_KEEP = 1_000
const infos: string[] = [] // dialogs and the like: printed, not counted as warnings
let dialogAnswer: { accept: boolean; text?: string } = { accept: false }
let browserRef: Browser | null = null
// Chrome counts script, layout and style time only while Performance is on: on from the run's start.
let perfSession: CDPSession | null = null
let tracing: string | null = null
let lastHeap: { used: number; nodes: number; listeners: number } | null = null
const LIGHTHOUSE = 'lighthouse@13.5.0'
const run$ = promisify(execFile)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`
const VITALS_JS = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0]
  let lcp = null, cls = 0
  try { new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) lcp = e[e.length - 1].startTime }).observe({ type: 'largest-contentful-paint', buffered: true }) } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value }).observe({ type: 'layout-shift', buffered: true }) } catch {}
  await new Promise((r) => setTimeout(r, 100))
  const res = performance.getEntriesByType('resource')
  const r = (n) => (typeof n === 'number' && n > 0 ? Math.round(n) : null)
  return {
    ttfb: nav ? r(nav.responseStart) : null, dcl: nav ? r(nav.domContentLoadedEventEnd) : null, load: nav ? r(nav.loadEventEnd) : null,
    lcp: r(lcp), cls: Math.round(cls * 1000) / 1000, resources: res.length,
    kb: Math.round(res.reduce((a, e) => a + (e.transferSize || 0), 0) / 1024), elements: document.getElementsByTagName('*').length,
  }
})()`

/** Chrome's own counters for the page (heap, DOM nodes, listeners, script and layout time). */
async function metrics(page: Page): Promise<Record<string, number>> {
  if (!perfSession) {
    perfSession = await page.context().newCDPSession(page)
    await perfSession.send('Performance.enable')
  }
  const { metrics: m } = await perfSession.send('Performance.getMetrics')
  return Object.fromEntries(m.map((x) => [x.name, x.value]))
}

/** Screenshots, snapshots, traces and reports from earlier days go (a heap snapshot is tens of MB). */
function sweepOld(): void {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000
    for (const f of readdirSync(SHOTS)) {
      const p = join(SHOTS, f)
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true })
    }
  } catch {}
}

async function heapSnapshot(page: Page): Promise<{ file: string; bytes: number }> {
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `${stamp()}.heapsnapshot`)
  const out = createWriteStream(file)
  const cdp = await page.context().newCDPSession(page)
  try {
    cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => { out.write(e.chunk) })
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
    await cdp.detach().catch(() => {})
  }
  return { file, bytes: statSync(file).size }
}

async function lighthouse(page: Page): Promise<Outcome> {
  const url = page.url()
  if (!/^https?:/.test(url)) return { ok: false, note: 'open a page first' }
  mkdirSync(SHOTS, { recursive: true })
  const report = join(SHOTS, `${stamp()}-lighthouse.json`)
  const desktop = (page.viewportSize()?.width ?? DESKTOP.width) > 600
  // Our Chrome on its debug port; storage is kept so the sign-in survives the audit.
  const args = ['-y', LIGHTHOUSE, url, `--port=${mode.port}`, '--output=json', `--output-path=${report}`, '--quiet', '--disable-storage-reset',
    '--only-categories=performance,accessibility,best-practices,seo', ...(desktop ? ['--preset=desktop'] : [])]
  try { await run$('npx', args, { timeout: 240_000, maxBuffer: 64 * 1024 * 1024 }) }
  catch (e) { return { ok: false, note: `lighthouse failed: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').pop()?.slice(0, 200)}` } }
  const r = JSON.parse(readFileSync(report, 'utf8'))
  return { ok: true, note: `${desktop ? 'desktop' : 'mobile'}, report ${report}`, print: lighthouseSummary(r).join('\n') }
}

const RENDERED_JS = `(() => {
  const text = (document.body ? document.body.innerText : '').trim()
  return { textChars: text.length, media: document.querySelectorAll('img, svg, canvas, video').length, text: text.slice(0, 500) }
})()`

const STORAGE_JS = `(() => {
  const dump = (st) => { const o = {}; for (let i = 0; i < st.length; i++) { const k = st.key(i); const v = st.getItem(k) || ''; o[k] = v.length > 120 ? v.slice(0, 117) + '...' : v } return o }
  try { return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) } } catch (e) { return { error: String(e) } }
})()`

function classifier(): Decisions | null {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) return null
  decisions ??= createDecisions({ apiKey: key })
  return decisions
}

async function ask(input: Parameters<typeof quickCheck>[1]) {
  const d = classifier()
  if (!d) return null
  const out = await quickCheck(d, input, { purpose: 'ui_check' })
  costMicroUsd += out.costMicroUsd
  calls += out.calls
  return out.answers
}

// Animations are left running. Playwright's animations: 'disabled' finishes
// finite CSS animations by firing animationend, and apps react to that: a
// react-toastify toast closes when its progress bar animation ends, so every
// `see` dismissed the toast it was asked about.
async function screenshot(page: Page, style?: string): Promise<Uint8Array> {
  return new Uint8Array(await page.screenshot({ type: 'png', caret: 'hide', ...(style ? { style } : {}) }))
}

const DEV_OVERLAYS_JS = `({
  nextPresent: !!document.querySelector(${JSON.stringify(NEXT_DEV_SELECTORS.join(', '))}),
  nextDialog: [...document.querySelectorAll('nextjs-portal')].some((h) => !!h.shadowRoot && !!h.shadowRoot.querySelector('[data-nextjs-dialog], [data-nextjs-dialog-overlay]')),
  viteOverlay: !!document.querySelector('vite-error-overlay'),
})`

async function saveShot(page: Page, why: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${++shotN}-${why}.jpg`)
  await page.screenshot({ path: file, type: 'jpeg', quality: 70 })
  return file
}

async function visibleText(page: Page): Promise<string> {
  const read = () => page.evaluate<string>(`document.body ? document.body.innerText : ''`)
  // A navigation in flight destroys the context the first read ran in.
  return read().catch(() => sleep(300).then(read)).catch(() => '')
}

/** The screenshot (dev overlays hidden) and the visible text, asked the questions in one call. */
async function judge(page: Page, questions: readonly QuickQuestion[]) {
  const overlays = await page.evaluate<{ nextPresent: boolean; nextDialog: boolean; viteOverlay: boolean }>(DEV_OVERLAYS_JS).catch(() => ({ nextPresent: true, nextDialog: false, viteOverlay: false }))
  const style = devOverlayStyle({ ...overlays, sawErrors: consoleLog.some((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) })
  const [png, text] = await Promise.all([screenshot(page, style), visibleText(page)])
  const jpg = await fitForLook(png, { maxAspect: 2.5 })
  return ask({ questions, material: tidyText(text, TEXT_CHARS), images: [{ format: 'jpg', data: jpg }] })
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {})
  await sleep(250)
}

/**
 * Each element a locator matched, as the ranking sees it (MatchInfo), or null when it is not visible.
 * A text match counts as the control around it. Page code, kept as a string: no DOM types here.
 */
const MATCH_JS = new Function('els', 'fields', `return els.slice(0, 60).map((raw) => {
  if (raw.closest('[data-ui-check-trigger]')) return null
  const r = raw.getBoundingClientRect()
  if (r.width < 1 || r.height < 1 || (raw.checkVisibility && !raw.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return null
  const el = fields ? raw : (raw.closest('button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], summary, label, input') || raw)
  const inViewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  let topmost = null
  if (inViewport) {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
    const root = raw.getRootNode()
    const at = (root.elementFromPoint ? root : document).elementFromPoint(x, y)
    topmost = !!at && (raw.contains(at) || el.contains(at) || (at.tagName === 'LABEL' && at.control === raw))
  }
  let dialog = !!el.closest('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')
  for (let a = el.parentElement; !dialog && a && a !== document.body; a = a.parentElement) {
    if (typeof a.className === 'string' && /drawer|modal|dialog|offcanvas|sheet/i.test(a.className) && getComputedStyle(a).position === 'fixed') dialog = true
  }
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[inert]') || (fields && raw.readOnly === true)
  const form = el.form || el.closest('form')
  const isSubmit = !!form && ((el.tagName === 'BUTTON' && el.type === 'submit') || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image')))
  const act = document.activeElement
  return {
    enabled: !disabled, inViewport, topmost, inDialog: dialog, isSubmit,
    inFocusedForm: !!form && !!act && act !== document.body && form.contains(act),
    inNav: !dialog && !!el.closest('nav, aside, header, footer, [role=navigation], [role=banner], [role=complementary], [role=contentinfo]'),
  }
})`) as (els: unknown[], fields: boolean) => (MatchInfo | null)[]

type Hit = { loc: Locator; how: string }

/**
 * The match a step means, among the visible elements one locator matches: the Nth (top to bottom)
 * when an ordinal is given, else the ranking's pick. Null when none is visible.
 */
async function choose(loc: Locator, how: string, fields: boolean, nth?: number): Promise<Hit | null> {
  const infos = await loc.evaluateAll(MATCH_JS, fields).catch(() => [] as (MatchInfo | null)[])
  const shown = infos.flatMap((m, i) => (m ? [{ i, m }] : []))
  if (shown.length === 0) return null
  if (nth !== undefined) {
    const pick = nth === -1 ? shown.at(-1) : shown[nth - 1]
    if (!pick) throw new Error(`only ${shown.length} ${shown.length === 1 ? 'match' : 'matches'}, no #${nth}`)
    return { loc: loc.nth(pick.i), how: shown.length > 1 ? `${how} (${shown.length} matches, chose #${nth === -1 ? shown.length : nth})` : how }
  }
  if (shown.length === 1) return { loc: loc.nth(shown[0]!.i), how }
  const r = rankMatches(shown.map((x) => x.m))
  return { loc: loc.nth(shown[r.index]!.i), how: `${how} (${shown.length} matches, chose ${r.why})` }
}

/**
 * Visible controls (or fields), marked so the chosen one can be found again. Page code, kept as a
 * string: the root tsconfig carries no DOM types.
 */
const CANDIDATES_JS = `(fields) => {
  const sel = fields
    ? 'input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable=true], [role=textbox], [role=combobox], [role=searchbox]'
    : 'button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], summary, input[type=submit], input[type=button], [onclick]'
  // Marks from an earlier pick would share indexes with this one's.
  for (const old of document.querySelectorAll('[data-ui-check]')) old.removeAttribute('data-ui-check')
  const clean = (s) => (s || '').trim().replace(/\\s+/g, ' ')
  const out = []
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || r.bottom < 0 || r.top > innerHeight) continue
    const idx = out.length
    el.setAttribute('data-ui-check', String(idx))
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : ''
    const name = [el.getAttribute('aria-label'), el.innerText, label, el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('name')]
      .map(clean).filter(Boolean).join(' | ').slice(0, 160)
    const box = el.closest('section, form, nav, header, aside, li, [role=dialog]')
    out.push({ idx, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name, context: box ? clean(box.innerText).slice(0, 120) : '' })
    if (out.length >= 200) break
  }
  return out
}`

async function candidates(page: Page, fields: boolean): Promise<Candidate[]> {
  return page.evaluate<Candidate[]>(`(${CANDIDATES_JS})(${fields})`)
}

/**
 * Fields whose label text is TARGET though the label is not wired to them: a label or text just
 * before the field (or before the box holding it), text inside a wrapping element, aria-labelledby.
 * They are marked data-ui-check-label="exact" or "loose" for the field tiers. For select, the
 * element right after the label counts too (a custom dropdown's trigger is often a plain div).
 */
const LABEL_JS = new Function('o', `
  for (const old of document.querySelectorAll('[data-ui-check-label]')) old.removeAttribute('data-ui-check-label')
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').replace(/[\\s*:]+$/, '').trim().toLowerCase()
  const want = norm(o.target)
  if (!want) return 0
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select, [contenteditable=""], [contenteditable=true], [role=textbox], [role=combobox], [role=searchbox], [role=spinbutton]'
    + (o.select ? ', button, [aria-haspopup], [role=button], [tabindex]:not([tabindex="-1"])' : '')
  const found = new Map()
  const add = (f, how) => { if (f && !(found.get(f) === 'exact')) found.set(f, how) }
  const fieldAfter = (l) => {
    for (let n = l, up = 0; n && n !== document.body && up < 3; n = n.parentElement, up++) {
      for (let sib = n.nextElementSibling; sib; sib = sib.nextElementSibling) {
        const f = sib.matches(FIELD) ? sib : sib.querySelector(FIELD)
        if (f) return f
        if (o.select && up === 0) return sib
      }
    }
    return null
  }
  for (const f of document.querySelectorAll('[aria-labelledby]')) {
    const t = norm(f.getAttribute('aria-labelledby').split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' '))
    if (t === want) add(f, 'exact'); else if (t.includes(want)) add(f, 'loose')
  }
  for (const l of document.querySelectorAll('label, legend, dt, th, span, div, p, strong, b, h3, h4, h5, h6')) {
    if (l.children.length > 3 || l.matches(FIELD)) continue
    const t = norm(l.innerText)
    if (!t || t.length > 80 || !t.includes(want)) continue
    const how = t === want ? 'exact' : 'loose'
    if (l.tagName === 'LABEL' && l.control) { add(l.control, how); continue }
    add(l.querySelector(FIELD) || fieldAfter(l), how)
  }
  for (const [f, how] of found) f.setAttribute('data-ui-check-label', how)
  return found.size
`) as (o: { target: string; select: boolean }) => number

/** The locators that name an element, best first: exact name, then looser names and text. */
function tiers(page: Page, target: string, fields: boolean): Array<[Locator, string]> {
  const any = (locs: Locator[]) => locs.reduce((a, b) => a.or(b))
  return fields
    ? [
        [any([page.getByLabel(target, { exact: true }), page.getByPlaceholder(target, { exact: true }), ...FIELD_ROLES.map((r) => page.getByRole(r, { name: target, exact: true }))]), 'name'],
        [any([page.getByLabel(target), page.getByPlaceholder(target), ...FIELD_ROLES.map((r) => page.getByRole(r, { name: target }))]), 'text'],
        [page.locator('[data-ui-check-label=exact]'), 'label'],
        [page.locator('[data-ui-check-label]'), 'label'],
      ]
    : [
        [any(CLICK_ROLES.map((r) => page.getByRole(r, { name: target, exact: true }))), 'name'],
        [any(CLICK_ROLES.map((r) => page.getByRole(r, { name: target }))), 'text'],
        [page.getByText(target, { exact: true }), 'text'],
        [page.getByText(target), 'text'],
      ]
}

/** The element words name: selector, role and name, label, text, "second TEXT"; then the classifier's pick. */
async function find(page: Page, verb: 'click' | 'hover' | 'fill' | 'select', target: string, nth?: number): Promise<Hit | null> {
  const fields = verb === 'fill' || verb === 'select'
  if (isSelector(target)) return choose(page.locator(target), 'selector', fields, nth)
  // A custom dropdown's trigger may be a button named for the field.
  const all = async (words: string) => {
    if (fields) await page.evaluate(LABEL_JS, { target: words, select: verb === 'select' }).catch(() => 0)
    return [...tiers(page, words, fields), ...(verb === 'select' ? tiers(page, words, false) : [])]
  }
  for (const [loc, how] of await all(target)) {
    const hit = await choose(loc, how, fields, nth)
    if (hit) return hit
  }
  const ord = nth === undefined ? splitOrdinal(target) : null
  if (ord) {
    for (const [loc, how] of await all(ord.rest)) {
      const hit = await choose(loc, how, fields, ord.nth)
      if (hit) return hit
    }
  }
  const cands = await candidates(page, fields)
  if (cands.length === 0) return null
  const answers = await ask({ questions: [pickQuestion(verb, target)], items: cands.map((c) => ({ id: String(c.idx), text: candidateText(c) })) })
  const best = answers ? bestCandidate(answers) : null
  if (!best) return null
  const loc = page.locator(`[data-ui-check="${best.idx}"]`).first()
  const c = cands.find((x) => x.idx === best.idx)
  return { loc, how: `picked "${(c?.name || c?.tag || '').slice(0, 50)}" p ${best.p.toFixed(2)}` }
}

// Playwright calls a function, not a string holding one (that is evaluated as an expression).
const IS_SELECT_JS = new Function('el', `return el.tagName === 'SELECT'`) as (el: unknown) => boolean
const IS_FILE_JS = new Function('el', `return el.tagName === 'INPUT' && el.type === 'file'`) as (el: unknown) => boolean
const FOCUSED_TEXT_JS = `(() => {
  const a = document.activeElement
  return !!a && ((a.tagName === 'INPUT' && /^(text|search|)$/i.test(a.getAttribute('type') || '')) || a.isContentEditable)
})()`
const OPTION_ROLES = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'gridcell'] as const

/**
 * select on anything but a native select: open the control, type into its search box when one has
 * focus (or appears), then click the option by its name or text, as click finds it (the control
 * itself is left out, since it often shows the current value).
 */
async function customSelect(page: Page, hit: Hit, option: string): Promise<Outcome> {
  await hit.loc.click({ timeout: 8_000 })
  await sleep(250)
  let typed = await page.evaluate<boolean>(FOCUSED_TEXT_JS).catch(() => false)
  if (!typed) {
    const search = page.locator('input[type=search], input[placeholder*="search" i], [role=listbox] input, [role=dialog] input, [role=combobox] input').filter({ visible: true })
    if (await search.count().catch(() => 0)) { await search.first().focus().catch(() => {}); typed = await page.evaluate<boolean>(FOCUSED_TEXT_JS).catch(() => false) }
  }
  if (typed) {
    await page.locator(':focus').fill(option, { timeout: 4_000 })
    await sleep(400)
  }
  await hit.loc.evaluate(MARK_TRIGGER_JS, true).catch(() => {})
  try {
    const any = (locs: Locator[]) => locs.reduce((a, b) => a.or(b))
    const optionTiers: Array<[Locator, string]> = [
      [any(OPTION_ROLES.map((r) => page.getByRole(r, { name: option, exact: true }))), 'option'],
      [any(OPTION_ROLES.map((r) => page.getByRole(r, { name: option }))), 'option'],
      ...tiers(page, option, false),
    ]
    let pick: Hit | null = null
    for (const [loc, how] of optionTiers) if ((pick = await choose(loc, how, false))) break
    pick ??= await find(page, 'click', option)
    if (!pick) return { ok: false, note: `${hit.how}; opened${typed ? `, typed "${option}"` : ''}, but no option "${option}" shows` }
    await pick.loc.click({ timeout: 8_000 })
    await settle(page)
    return { ok: true, note: `${hit.how}; opened${typed ? `, typed "${option}"` : ''}, clicked ${pick.how}` }
  } finally { await hit.loc.evaluate(MARK_TRIGGER_JS, false).catch(() => {}) }
}

const MARK_TRIGGER_JS = new Function('el', 'on', `if (on) el.setAttribute('data-ui-check-trigger', ''); else el.removeAttribute('data-ui-check-trigger')`) as (el: unknown, on: boolean) => void

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown

/**
 * eval: an expression is awaited as before. Statements run the way the DevTools console runs them
 * (REPL mode: top-level await, the last statement's value), and a body with a top-level return runs
 * as a function body. The script is parsed here first, so it runs once even when it throws.
 */
async function evaluate(page: Page, script: string): Promise<unknown> {
  try {
    new AsyncFunction(`return (${script}\n)`)
    return await page.evaluate(`(async () => (${script}\n))()`)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
  }
  const cdp = await page.context().newCDPSession(page)
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: script, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true })
    const ex = r.exceptionDetails
    if (!ex) return r.result.value
    const msg = ex.exception?.description ?? ex.text
    if (!/^SyntaxError: Illegal return statement/.test(msg)) throw new Error(msg.split('\n')[0])
  } finally { await cdp.detach().catch(() => {}) }
  return page.evaluate(`(async () => {\n${script}\n})()`)
}

// ── steps ────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; note?: string; print?: string }

/**
 * The window size, and touch for phones and tablets: CDP's touch emulation gives the page touch events, one touch
 * point and the coarse-pointer, no-hover media a real device reports. Its session is kept for the run (a detached
 * session drops the override).
 */
let touchSession: CDPSession | null = null
let touchOn = false
/** True when it left a touch size and so reloaded the page. */
async function setWindow(page: Page, width: number, height: number, touch: boolean): Promise<boolean> {
  await page.setViewportSize({ width, height })
  const leavingTouch = !touch && touchOn
  if (touch) {
    touchSession ??= await page.context().newCDPSession(page)
    await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }).catch(() => {})
  } else if (touchSession) {
    // Detaching drops the session's overrides; turning touch off on it left the pointer coarse.
    await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
    await touchSession.detach().catch(() => {})
    touchSession = null
  }
  touchOn = touch
  // Chrome keeps reporting a coarse pointer and no hover after touch goes off, until the page loads again.
  if (leavingTouch && /^https?:/.test(page.url())) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(page) }
  else await sleep(300)
  return leavingTouch
}

async function run(page: Page, s: Step): Promise<Outcome> {
  if (isDevice(s.verb)) {
    const d = DEVICES[s.verb]
    const reloaded = await setWindow(page, d.width, d.height, d.touch)
    return { ok: true, note: `${d.width}x${d.height}${d.touch ? ', touch' : ''}${reloaded ? ', page reloaded to leave touch' : ''}` }
  }
  switch (s.verb) {
    case 'open': {
      const res = await page.goto(resolveUrl(s.target, base), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await settle(page)
      const status = res?.status() ?? 0
      return { ok: status < 400, note: `${status || 'no response'} ${page.url()}` }
    }
    case 'click': case 'hover': {
      const hit = await find(page, s.verb, s.target, s.nth)
      if (!hit) return { ok: false, note: 'nothing matches' }
      if (s.verb === 'click') await hit.loc.click({ timeout: 8_000 })
      else await hit.loc.hover({ timeout: 8_000 })
      await settle(page)
      return { ok: true, note: hit.how }
    }
    case 'fill': case 'select': {
      const hit = await find(page, s.verb, s.target, s.nth)
      if (!hit) return { ok: false, note: 'no such field' }
      if (s.verb === 'fill') await hit.loc.fill(s.value, { timeout: 8_000 })
      else if (await hit.loc.evaluate(IS_SELECT_JS)) await hit.loc.selectOption({ label: s.value }, { timeout: 8_000 })
      else return customSelect(page, hit, s.value)
      return { ok: true, note: hit.how }
    }
    case 'drag': {
      const from = await find(page, 'click', s.target)
      if (!from) return { ok: false, note: 'nothing matches the start' }
      await from.loc.scrollIntoViewIfNeeded()
      const a = await from.loc.boundingBox()
      // Found after the start's box is read: a classifier pick re-marks the page.
      const to = await find(page, 'click', s.value)
      if (!to) return { ok: false, note: 'nothing matches the target' }
      const b = await to.loc.boundingBox()
      if (!a || !b) return { ok: false, note: 'an element has no box on screen' }
      const ax = a.x + a.width / 2, ay = a.y + a.height / 2
      await page.mouse.move(ax, ay)
      await page.mouse.down()
      await page.mouse.move(ax + 6, ay + 6, { steps: 3 })
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 })
      await page.mouse.up()
      await settle(page)
      return { ok: true, note: `${from.how} onto ${to.how}` }
    }
    case 'upload': {
      const file = resolve(s.value)
      if (!existsSync(file)) return { ok: false, note: `no such file: ${file}` }
      const hit = await find(page, 'click', s.target)
      if (hit) {
        if (await hit.loc.evaluate(IS_FILE_JS)) {
          await hit.loc.setInputFiles(file)
          return { ok: true, note: `${hit.how}, file field` }
        }
        const chooser = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null)
        await hit.loc.click({ timeout: 8_000 })
        const picker = await chooser
        if (picker) { await picker.setFiles(file); await settle(page); return { ok: true, note: `${hit.how}, file picker` } }
      }
      const input = page.locator('input[type=file]')
      if (!(await input.count())) return { ok: false, note: 'no file field or picker found' }
      await input.first().setInputFiles(file)
      await settle(page)
      return { ok: true, note: "the page's first file input" }
    }
    case 'ignore':
      ignores.push(s.pattern)
      return { ok: true }
    case 'dialog':
      dialogAnswer = dialogPolicy(s.answer)
      return { ok: true, note: dialogAnswer.accept ? `dialogs accepted${dialogAnswer.text !== undefined ? ` with "${dialogAnswer.text}"` : ''}` : 'dialogs dismissed' }
    case 'perf': {
      const v = await page.evaluate<Record<string, number | null>>(VITALS_JS)
      const m = await metrics(page)
      const ms = (n: number | null | undefined) => (n == null ? '-' : `${n} ms`)
      return { ok: true, print: [
        `TTFB ${ms(v.ttfb)}, DOMContentLoaded ${ms(v.dcl)}, load ${ms(v.load)}, LCP ${ms(v.lcp)}, CLS ${v.cls}`,
        `since this run began: script ${Math.round((m.ScriptDuration ?? 0) * 1000)} ms, layout ${Math.round((m.LayoutDuration ?? 0) * 1000)} ms, style ${Math.round((m.RecalcStyleDuration ?? 0) * 1000)} ms, tasks ${Math.round((m.TaskDuration ?? 0) * 1000)} ms`,
        `${v.elements} elements, ${v.resources} resources, ${v.kb} KB transferred, JS heap ${mb(m.JSHeapUsedSize ?? 0)}`,
      ].join('\n') }
    }
    case 'heap': {
      const snap = await heapSnapshot(page)
      const m = await metrics(page)
      const now = { used: m.JSHeapUsedSize ?? 0, nodes: m.Nodes ?? 0, listeners: m.JSEventListeners ?? 0 }
      const d = lastHeap ? `; since the last heap: ${now.used >= lastHeap.used ? '+' : ''}${mb(now.used - lastHeap.used)}, ${now.nodes - lastHeap.nodes >= 0 ? '+' : ''}${now.nodes - lastHeap.nodes} nodes, ${now.listeners - lastHeap.listeners >= 0 ? '+' : ''}${now.listeners - lastHeap.listeners} listeners` : ''
      lastHeap = now
      return { ok: true, note: `snapshot ${snap.file} (${mb(snap.bytes)})`, print: `JS heap ${mb(now.used)} of ${mb(m.JSHeapTotalSize ?? 0)}, ${now.nodes} DOM nodes, ${now.listeners} listeners, ${m.Documents ?? 0} documents${d}` }
    }
    case 'trace': {
      if (!browserRef) return { ok: false, note: 'no browser' }
      if (s.action === 'start') {
        if (tracing) return { ok: false, note: 'a trace is already running' }
        mkdirSync(SHOTS, { recursive: true })
        tracing = join(SHOTS, `${stamp()}-trace.json`)
        await browserRef.startTracing(page, { path: tracing, screenshots: true })
        return { ok: true, note: 'tracing' }
      }
      if (!tracing) return { ok: false, note: 'no trace started in this run' }
      await browserRef.stopTracing()
      const file = tracing
      tracing = null
      return { ok: true, note: `${file} (${mb(statSync(file).size)}), open it in the DevTools Performance panel` }
    }
    case 'lighthouse': return lighthouse(page)
    case 'press':
      await page.keyboard.press(s.key)
      await settle(page)
      return { ok: true }
    case 'wait':
      if ('seconds' in s) { await sleep(s.seconds * 1000); return { ok: true } }
      try { await page.getByText(s.text).first().waitFor({ state: 'visible', timeout: 15_000 }); return { ok: true } }
      catch { return { ok: false, note: 'not shown after 15 s' } }
    case 'see': case 'nosee': {
      if (!classifier()) return { ok: false, note: 'OPENROUTER_API_KEY is not set' }
      await settleForLook(page)
      const once = async () => (await judge(page, [seeQuestion(s.claim)]))?.find((a) => a.id === SEE_ID)?.p ?? null
      const v = await judgeWithRetry(s.verb, once, async () => { await sleep(500); await settleForLook(page) })
      return { ok: v.ok, note: v.note }
    }
    case 'look': {
      if (!classifier()) return { ok: true, note: 'skipped: OPENROUTER_API_KEY is not set' }
      await settleForLook(page)
      const answers = await judge(page, LOOK_QUESTIONS)
      if (!answers || answers.every((a) => a.p === null)) return { ok: true, note: 'no answer from the classifier' }
      const problems = lookProblems(answers)
      if (lookFails(answers)) return { ok: false, note: problems.join(', ') }
      if (problems.length) warnings++
      return { ok: true, note: problems.length ? `WARN ${problems.join(', ')}` : 'clean' }
    }
    case 'scroll': {
      if (s.target === 'down' || s.target === 'up') await page.mouse.wheel(0, (s.target === 'down' ? 1 : -1) * (page.viewportSize()?.height ?? 800) * 0.8)
      else {
        const loc = page.getByText(s.target).first()
        if (!(await loc.count())) return { ok: false, note: 'text not on the page' }
        await loc.scrollIntoViewIfNeeded()
      }
      await sleep(300)
      return { ok: true }
    }
    case 'size': {
      const reloaded = await setWindow(page, s.width, s.height, s.touch ?? false)
      return { ok: true, note: `${s.width}x${s.height}${s.touch ? ', touch' : ''}${reloaded ? ', page reloaded to leave touch' : ''}` }
    }
    case 'motion': await page.emulateMedia({ reducedMotion: s.reduce ? 'reduce' : 'no-preference' }); await sleep(300); return { ok: true }
    case 'dark': case 'light': await page.emulateMedia({ colorScheme: s.verb }); await rememberScheme(s.verb); await sleep(300); return { ok: true }
    case 'shot': return { ok: true, note: await saveShot(page, 'shot') }
    case 'read': return { ok: true, print: (await visibleText(page)).slice(0, 2_000) }
    case 'eval': {
      const v = await evaluate(page, s.script)
      return { ok: true, print: typeof v === 'string' ? v : JSON.stringify(v) }
    }
    case 'console':
      return { ok: true, print: consoleLog.length ? consoleLog.slice(-60).join('\n') : '(no console messages in this run)' }
    case 'network': {
      const hits = netLog.filter((n) => n.url.includes(s.filter) || n.type === s.filter || String(n.status) === s.filter)
      const rows = hits.slice(-60).map((n) => `${n.method.padEnd(6)} ${String(n.status).padEnd(6)} ${`${n.ms} ms`.padStart(8)}  ${n.type.padEnd(10)} ${n.url}${n.error ? `  (${n.error})` : ''}`)
      return { ok: true, print: rows.length ? `${hits.length} requests${hits.length > 60 ? ', last 60 shown' : ''}\n${rows.join('\n')}` : '(no matching requests in this run)' }
    }
    case 'response': {
      const hit = [...netLog].reverse().find((n) => n.response && n.url.includes(s.filter))
      if (!hit?.response) return { ok: false, note: 'no matching response in this run' }
      const headers = Object.entries(await hit.response.allHeaders()).map(([k, v]) => `${k}: ${/^(set-)?cookie$|authorization/i.test(k) ? '(hidden)' : v}`)
      const body = await hit.response.text().catch((e: Error) => `(no body: ${e.message.split('\n')[0]})`)
      return { ok: true, print: `${hit.method} ${hit.url}\n${hit.status}\n${headers.join('\n')}\n\n${body.slice(0, 2_000)}${body.length > 2_000 ? `\n... (${body.length} characters)` : ''}` }
    }
    case 'cookies': {
      const cookies = await page.context().cookies(page.url().startsWith('http') ? page.url() : undefined)
      const rows = cookies.map((c) => `${c.name}  ${c.domain}${c.path}  ${[c.httpOnly && 'httpOnly', c.secure && 'secure', c.sameSite].filter(Boolean).join(' ')}  ${c.expires > 0 ? `expires ${new Date(c.expires * 1000).toISOString().slice(0, 10)}` : 'session'}  value ${c.value.length} chars`)
      return { ok: true, print: rows.length ? rows.join('\n') : '(no cookies for this page)' }
    }
    case 'cookie': {
      const url = page.url()
      if (!/^https?:/.test(url)) return { ok: false, note: 'open a page first' }
      const ctx = page.context()
      const same = (await ctx.cookies(url)).find((c) => c.name === s.name)
      if (same) {
        await ctx.addCookies([{ ...same, value: s.value }])
        return { ok: true, note: `replaced the one for ${same.domain}${same.path}${same.httpOnly ? ', httpOnly' : ''}` }
      }
      await ctx.addCookies([{ name: s.name, value: s.value, url: `${new URL(url).origin}/`, sameSite: 'Lax' }])
      return { ok: true, note: `set for ${new URL(url).host}` }
    }
    case 'clear-cookies': {
      const ctx = page.context()
      const domain = s.domain ? new RegExp(`(^|\\.)${s.domain.replace(/^\./, '').replace(/[.]/g, '\\.')}$`, 'i') : undefined
      const n = (await ctx.cookies()).filter((c) => !domain || domain.test(c.domain)).length
      await ctx.clearCookies(domain ? { domain } : undefined)
      return { ok: true, note: `${n} cleared` }
    }
    case 'storage': return { ok: true, print: JSON.stringify(await page.evaluate(STORAGE_JS), null, 2) }
    case 'a11y': {
      const tree = await page.locator('body').ariaSnapshot({ timeout: 8_000 })
      return { ok: true, print: tree.length > 3_000 ? `${tree.slice(0, 3_000)}\n... (${tree.length} characters)` : tree }
    }
    case 'back': await page.goBack(); await settle(page); return { ok: true }
    case 'reload': await page.reload(); await settle(page); return { ok: true }
  }
}

async function main(): Promise<void> {
  // One run at a time on a tab: a second run of this session waits for the first.
  const releaseTab = await acquireLock(tabLock(mode, SESSION), 300_000, (pid) => console.log(`info waiting for another run on this session's tab (pid ${pid})`))
  process.on('exit', releaseTab)
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]] as const) process.on(sig, () => process.exit(128 + n))
  await ensureChrome()
  await pruneOrphanTabs()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${mode.port}`)
  const page = await sessionPage(browser)
  trackRequests(page)
  browserRef = browser
  sweepOld()
  await metrics(page).catch(() => {})
  if (show) await page.bringToFront().catch(() => {})
  await page.setViewportSize(DESKTOP)
  if (mode.headless && !(await page.evaluate('matchMedia("(hover: hover)").matches').catch(() => true))) {
    infos.push('this hidden Chrome was started without a mouse, so hover styles are off: run "ui-check --close" when no other session is checking, and the next run starts it with one')
  }
  const origin = () => { try { return new URL(base).origin } catch { return '' } }
  page.on('pageerror', (e) => {
    pageErrors.push(e.message.split('\n')[0]!.slice(0, 200))
    consoleLog.push(`[pageerror] ${e.message.slice(0, 500)}`)
  })
  page.on('dialog', (d) => {
    // beforeunload is always let through, so a navigation step is never held on the page.
    const accept = d.type() === 'beforeunload' || dialogAnswer.accept
    const answered = accept ? d.accept(d.type() === 'prompt' ? dialogAnswer.text ?? d.defaultValue() : undefined) : d.dismiss()
    void answered.catch(() => {})
    const line = `dialog ${d.type()} "${d.message().slice(0, 160)}" ${accept ? 'accepted' : 'dismissed'}`
    infos.push(line)
    consoleLog.push(`[dialog] ${line}`)
  })
  page.on('console', (m) => {
    consoleLog.push(`[${m.type()}] ${m.text().slice(0, 500)}`)
    if (m.type() === 'error') pending.push({ text: `console: ${m.text().split('\n')[0]!.slice(0, 200)}`, url: m.location().url })
  })
  const logRequest = (e: NetEntry) => { netLog.push(e); if (netLog.length > NET_KEEP) netLog.shift() }
  page.on('requestfinished', (r) => {
    void r.response().then((res) => {
      const t = r.timing()
      logRequest({ method: r.method(), url: r.url(), status: res?.status() ?? 0, ms: Math.max(0, Math.round(t.responseEnd)), type: r.resourceType(), response: res })
    }).catch(() => {})
  })
  // Server errors on any request, refusals on writes (a GET 401 on the sign-in page is expected).
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) stepDoc = r.status()
    if ((r.status() >= 500 || (r.status() >= 400 && r.request().method() !== 'GET')) && r.url().startsWith(origin())) pending.push({ text: `${r.status()} ${r.request().method()} ${r.url().replace(origin(), '')}`, url: r.url() })
  })
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? ''
    logRequest({ method: r.method(), url: r.url(), status: 'failed', ms: Math.max(0, Math.round(r.timing().responseEnd)), type: r.resourceType(), response: null, error: why })
    if (r.url().startsWith(origin()) && !/ERR_ABORTED/.test(why)) pending.push({ text: `failed ${r.method()} ${r.url().replace(origin(), '')}: ${why}`, url: r.url() })
  })

  for (const [i, s] of steps.entries()) {
    if (i > 0 && pauseMs) await sleep(pauseMs)
    const began = Date.now()
    stepDoc = null
    const urlBefore = page.url()
    let out: Outcome
    try { out = await run(page, s) } catch (e) { out = { ok: false, note: (e as Error).message.split('\n')[0]!.slice(0, 200) } }
    const errors: string[] = []
    for (const e of pageErrors.splice(0)) if (ignoredBy(ignores, e)) infos.push(`ignored: page error: ${e}`); else errors.push(e)
    if (errors.length) {
      // On a page that loaded and rendered, an error elsewhere (a failed server action, say) is a warning.
      const shown = stepDoc === null ? null : await page.evaluate<{ textChars: number; media: number; text: string }>(RENDERED_JS).catch(() => null)
      if (shown && !pageErrorsFail({ docStatus: stepDoc, ...shown })) pending.push(...errors.map((e) => ({ text: `page error: ${e}` })))
      else out = { ok: false, note: [out.note, `page error: ${errors.join('; ')}`].filter(Boolean).join('; ') }
    }
    // Where a click, key or select took the page, as open says.
    if (s.verb !== 'open' && page.url() !== urlBefore) out.note = `${out.note ? `${out.note} ` : ''}-> ${page.url()}`
    if (!out.ok) { failures++; out.note = `${out.note ?? ''} [${await saveShot(page, 'fail').catch(() => 'no screenshot')}]`.trim() }
    const ms = Date.now() - began
    console.log(`${out.ok ? 'ok  ' : 'FAIL'} ${stepLabel(s)}${out.note ? `  ${out.note}` : ''}  (${ms} ms)`)
    if (out.print !== undefined) console.log(out.print.split('\n').map((l) => `     ${l}`).join('\n'))
    for (const n of pending.splice(0)) if (ignoredBy(ignores, n.text, n.url ?? '')) infos.push(`ignored: ${n.text}`); else pending.push(n)
    for (const n of [...new Set(infos.splice(0))]) console.log(`info ${n}`)
    if (pending.length) {
      const notes = [...new Set(pending.map((n) => n.text))]
      warnings += notes.length
      for (const n of notes.slice(0, 6)) console.log(`warn ${n}`)
      pending.length = 0
    }
  }
  if (tracing && browserRef) {
    await browserRef.stopTracing().catch(() => {})
    console.log(`info the trace was still running and is saved: ${tracing}`)
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n${steps.length} steps, ${failures} failed, ${warnings} warnings, ${calls} classifier calls ($${(costMicroUsd / 1e6).toFixed(4)}), ${secs} s`)
  if (close) {
    await page.close().catch(() => {})
    await forgetSession(mode)
    await stopUnlessShared(mode, true)
  }
}

main().then(
  () => process.exit(failures ? 1 : 0),
  (e) => { console.error(`ui-check: ${(e as Error).message}`); process.exit(2) },
)
