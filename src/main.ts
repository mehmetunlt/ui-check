/**
 * ui-check: scripted checks of a web app in one persistent Chrome, judged by the fast classifier.
 *
 * The steps (steps.ts, `--help`) run straight through playwright-core over CDP: no model reads the
 * page between steps, so a walk costs seconds and a fraction of a cent, and only one line per step
 * comes back. The classifier (jev-1.14 with images, through the decisions client) is asked only
 * where a step needs a judgment: `see`/`nosee` and the health `look` send the viewport screenshot
 * with the visible text as context, and a click or fill whose words match nothing asks which
 * visible control they mean. Every step also reports new page errors (fail), console errors and
 * failed same-origin requests (warn); `look` fails on an error screen and warns on a blank or broken one.
 *
 * Chrome keeps running between runs with its own profile under ~/.cache/agents-ui-check, so a
 * sign-in is kept and successive checks reuse one tab. By default it is headless (port 9334), so
 * nothing comes up on the screen; `--show` (and `--slow`) use a visible window instead (port 9333,
 * a profile of its own, so each keeps its own sign-ins). `--close` stops both by the PIDs they
 * wrote, never by pattern. Screenshots go to
 * $TMPDIR/agents-ui-check and their paths are printed (on `shot` and on every failure).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page, type Response } from 'playwright-core'
import { createDecisions } from './classifier/client.ts'
import { quickCheck, type QuickQuestion } from './classifier/quick-check.ts'
import type { Decisions } from './classifier/types.ts'
import { fitForLook } from './look-image.ts'
import {
  LOOK_QUESTIONS, SEE_ID, USAGE, bestCandidate, candidateText, isSelector, lookFails, lookProblems, parseSteps, pickQuestion, planWords,
  resolveUrl, seeQuestion, seeVerdict, stepLabel, type Candidate, type Step,
} from './steps.ts'


const STATE_DIR = join(homedir(), '.cache', 'agents-ui-check')
type Mode = { port: number; profile: string; pidFile: string; headless: boolean }
const MODES: Record<'shown' | 'hidden', Mode> = {
  shown: { port: 9333, profile: join(STATE_DIR, 'profile'), pidFile: join(STATE_DIR, 'chrome.pid'), headless: false },
  hidden: { port: 9334, profile: join(STATE_DIR, 'profile-hidden'), pidFile: join(STATE_DIR, 'chrome-hidden.pid'), headless: true },
}
const SHOTS = join(tmpdir(), 'agents-ui-check')
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p))
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
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

if (close && words.length === 0) {
  stopChrome(MODES.shown)
  stopChrome(MODES.hidden)
  process.exit(0)
}
const mode = show ? MODES.shown : MODES.hidden
let steps: Step[]
try { steps = parseSteps(words) } catch (e) { console.error((e as Error).message); process.exit(2) }
if (steps.length === 0) { console.log(USAGE); process.exit(2) }

// ── Chrome ───────────────────────────────────────────────────────────────────
async function endpointUp(): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${mode.port}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch { return false }
}

async function ensureChrome(): Promise<void> {
  if (await endpointUp()) return
  if (!CHROME) throw new Error('no Chrome found (set CHROME_PATH)')
  mkdirSync(mode.profile, { recursive: true })
  const child = spawn(CHROME, [
    `--remote-debugging-port=${mode.port}`, `--user-data-dir=${mode.profile}`, '--no-first-run', '--no-default-browser-check',
    ...(mode.headless ? ['--headless=new', '--hide-scrollbars', '--window-size=1280,800'] : ['--window-size=1300,940']), 'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(mode.pidFile, String(child.pid))
  for (let i = 0; i < 50; i++) {
    if (await endpointUp()) return
    await sleep(200)
  }
  throw new Error(`Chrome did not open its debug port ${mode.port}`)
}

function stopChrome(m: Mode): void {
  const which = m.headless ? 'hidden' : 'visible'
  if (!existsSync(m.pidFile)) { console.log(`no ${which} ui-check Chrome is running`); return }
  const pid = Number(readFileSync(m.pidFile, 'utf8'))
  try { process.kill(pid, 'SIGTERM'); console.log(`stopped the ${which} ui-check Chrome (pid ${pid})`) } catch { console.log(`the ${which} ui-check Chrome was not running`) }
  rmSync(m.pidFile, { force: true })
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
const pending: string[] = [] // console and network notes since the last step
let pageErrors: string[] = []
// Everything this run saw, for the console and network steps.
const consoleLog: string[] = []
type NetEntry = { method: string; url: string; status: number | 'failed'; ms: number; type: string; response: Response | null; error?: string }
const netLog: NetEntry[] = []
const NET_KEEP = 1_000
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

async function screenshot(page: Page): Promise<Uint8Array> {
  return new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }))
}

async function saveShot(page: Page, why: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${++shotN}-${why}.jpg`)
  await page.screenshot({ path: file, type: 'jpeg', quality: 70 })
  return file
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate<string>(`(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n')`).catch(() => '')
}

/** The screenshot and visible text, asked the questions in one call. */
async function judge(page: Page, questions: readonly QuickQuestion[]) {
  const [png, text] = await Promise.all([screenshot(page), visibleText(page)])
  const jpg = await fitForLook(png, { maxAspect: 2.5 })
  return ask({ questions, material: text.slice(0, TEXT_CHARS), images: [{ format: 'jpg', data: jpg }] })
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {})
  await sleep(250)
}

async function firstVisible(locs: Locator[]): Promise<Locator | null> {
  for (const l of locs) {
    const n = await l.count().catch(() => 0)
    for (let i = 0; i < Math.min(n, 8); i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i)
  }
  return null
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

/** The element words name: selector, role and name, label, text; then the classifier's pick. */
async function find(page: Page, verb: 'click' | 'hover' | 'fill' | 'select', target: string): Promise<{ loc: Locator; how: string } | null> {
  if (isSelector(target)) {
    const loc = await firstVisible([page.locator(target)])
    return loc ? { loc, how: 'selector' } : null
  }
  const fields = verb === 'fill' || verb === 'select'
  const exact = await firstVisible(fields
    ? [page.getByLabel(target, { exact: true }), page.getByPlaceholder(target, { exact: true }), ...FIELD_ROLES.map((r) => page.getByRole(r, { name: target, exact: true }))]
    : CLICK_ROLES.map((r) => page.getByRole(r, { name: target, exact: true })))
  if (exact) return { loc: exact, how: 'name' }
  const loose = await firstVisible(fields
    ? [page.getByLabel(target), page.getByPlaceholder(target), ...FIELD_ROLES.map((r) => page.getByRole(r, { name: target }))]
    : [...CLICK_ROLES.map((r) => page.getByRole(r, { name: target })), page.getByText(target, { exact: true }), page.getByText(target)])
  if (loose) return { loc: loose, how: 'text' }
  const cands = await candidates(page, fields)
  if (cands.length === 0) return null
  const answers = await ask({ questions: [pickQuestion(verb, target)], items: cands.map((c) => ({ id: String(c.idx), text: candidateText(c) })) })
  const best = answers ? bestCandidate(answers) : null
  if (!best) return null
  const loc = page.locator(`[data-ui-check="${best.idx}"]`).first()
  const c = cands.find((x) => x.idx === best.idx)
  return { loc, how: `picked "${(c?.name || c?.tag || '').slice(0, 50)}" p ${best.p.toFixed(2)}` }
}

// ── steps ────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; note?: string; print?: string }

async function run(page: Page, s: Step): Promise<Outcome> {
  switch (s.verb) {
    case 'open': {
      const res = await page.goto(resolveUrl(s.target, base), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await settle(page)
      const status = res?.status() ?? 0
      return { ok: status < 400, note: `${status || 'no response'} ${page.url()}` }
    }
    case 'click': case 'hover': {
      const hit = await find(page, s.verb, s.target)
      if (!hit) return { ok: false, note: 'nothing matches' }
      if (s.verb === 'click') await hit.loc.click({ timeout: 8_000 })
      else await hit.loc.hover({ timeout: 8_000 })
      await settle(page)
      return { ok: true, note: hit.how }
    }
    case 'fill': case 'select': {
      const hit = await find(page, s.verb, s.target)
      if (!hit) return { ok: false, note: 'no such field' }
      if (s.verb === 'fill') await hit.loc.fill(s.value, { timeout: 8_000 })
      else await hit.loc.selectOption({ label: s.value }, { timeout: 8_000 })
      return { ok: true, note: hit.how }
    }
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
      const answers = await judge(page, [seeQuestion(s.claim)])
      const v = seeVerdict(s.verb, answers?.find((a) => a.id === SEE_ID)?.p ?? null)
      return { ok: v.ok, note: v.note }
    }
    case 'look': {
      if (!classifier()) return { ok: true, note: 'skipped: OPENROUTER_API_KEY is not set' }
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
    case 'phone': await page.setViewportSize(PHONE); await sleep(300); return { ok: true }
    case 'desktop': await page.setViewportSize(DESKTOP); await sleep(300); return { ok: true }
    case 'dark': case 'light': await page.emulateMedia({ colorScheme: s.verb }); await sleep(300); return { ok: true }
    case 'shot': return { ok: true, note: await saveShot(page, 'shot') }
    case 'read': return { ok: true, print: (await visibleText(page)).slice(0, 2_000) }
    case 'eval': {
      const v = await page.evaluate(`(async () => (${s.script}))()`)
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
  await ensureChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${mode.port}`)
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  if (show) await page.bringToFront().catch(() => {})
  await page.setViewportSize(DESKTOP)
  const origin = () => { try { return new URL(base).origin } catch { return '' } }
  page.on('pageerror', (e) => {
    pageErrors.push(e.message.split('\n')[0]!.slice(0, 200))
    consoleLog.push(`[pageerror] ${e.message.slice(0, 500)}`)
  })
  page.on('console', (m) => {
    consoleLog.push(`[${m.type()}] ${m.text().slice(0, 500)}`)
    if (m.type() === 'error') pending.push(`console: ${m.text().split('\n')[0]!.slice(0, 200)}`)
  })
  const logRequest = (e: NetEntry) => { netLog.push(e); if (netLog.length > NET_KEEP) netLog.shift() }
  page.on('requestfinished', (r) => {
    void r.response().then((res) => {
      const t = r.timing()
      logRequest({ method: r.method(), url: r.url(), status: res?.status() ?? 0, ms: Math.max(0, Math.round(t.responseEnd)), type: r.resourceType(), response: res })
    }).catch(() => {})
  })
  // Server errors on any request, refusals on writes (a GET 401 on the sign-in page is expected).
  page.on('response', (r) => { if ((r.status() >= 500 || (r.status() >= 400 && r.request().method() !== 'GET')) && r.url().startsWith(origin())) pending.push(`${r.status()} ${r.request().method()} ${r.url().replace(origin(), '')}`) })
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? ''
    logRequest({ method: r.method(), url: r.url(), status: 'failed', ms: Math.max(0, Math.round(r.timing().responseEnd)), type: r.resourceType(), response: null, error: why })
    if (r.url().startsWith(origin()) && !/ERR_ABORTED/.test(why)) pending.push(`failed ${r.method()} ${r.url().replace(origin(), '')}: ${why}`)
  })

  for (const [i, s] of steps.entries()) {
    if (i > 0 && pauseMs) await sleep(pauseMs)
    const began = Date.now()
    let out: Outcome
    try { out = await run(page, s) } catch (e) { out = { ok: false, note: (e as Error).message.split('\n')[0]!.slice(0, 200) } }
    if (pageErrors.length) { out = { ok: false, note: [out.note, `page error: ${pageErrors.join('; ')}`].filter(Boolean).join('; ') }; pageErrors = [] }
    if (!out.ok) { failures++; out.note = `${out.note ?? ''} [${await saveShot(page, 'fail').catch(() => 'no screenshot')}]`.trim() }
    const ms = Date.now() - began
    console.log(`${out.ok ? 'ok  ' : 'FAIL'} ${stepLabel(s)}${out.note ? `  ${out.note}` : ''}  (${ms} ms)`)
    if (out.print !== undefined) console.log(out.print.split('\n').map((l) => `     ${l}`).join('\n'))
    if (pending.length) {
      const notes = [...new Set(pending)]
      warnings += notes.length
      for (const n of notes.slice(0, 6)) console.log(`warn ${n}`)
      pending.length = 0
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n${steps.length} steps, ${failures} failed, ${warnings} warnings, ${calls} classifier calls ($${(costMicroUsd / 1e6).toFixed(4)}), ${secs} s`)
  if (close) { await browser.close().catch(() => {}); stopChrome(mode) }
}

main().then(
  () => process.exit(failures ? 1 : 0),
  (e) => { console.error(`ui-check: ${(e as Error).message}`); process.exit(2) },
)
