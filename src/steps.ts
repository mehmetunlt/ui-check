/**
 * The pure half of ui-check: the step grammar, the plan-file tokenizer, the questions the
 * classifier is asked about a screen, and how answers become pass, fail or warn. No browser, no network.
 */
import type { QuickQuestion } from './classifier/quick-check.ts'

export type Step =
  | { verb: 'open'; target: string }
  | { verb: 'click' | 'hover'; target: string; nth?: number }
  | { verb: 'fill' | 'select'; target: string; value: string; nth?: number }
  | { verb: 'drag' | 'upload'; target: string; value: string }
  | { verb: 'dialog'; answer: string }
  | { verb: 'trace'; action: 'start' | 'stop' }
  | { verb: 'press'; key: string }
  | { verb: 'wait'; seconds: number }
  | { verb: 'wait'; text: string }
  | { verb: 'see' | 'nosee'; claim: string }
  | { verb: 'scroll'; target: string }
  | { verb: 'eval'; script: string }
  | { verb: 'network'; filter: string }
  | { verb: 'response'; filter: string }
  | { verb: 'phone' | 'desktop' | 'dark' | 'light' | 'shot' | 'read' | 'look' | 'back' | 'reload' | 'console' | 'cookies' | 'storage' | 'a11y' | 'perf' | 'heap' | 'lighthouse' }

/** How many words each verb takes after it. */
export const VERB_ARITY: Record<Step['verb'], number> = {
  open: 1, click: 1, hover: 1, fill: 2, select: 2, press: 1, wait: 1, see: 1, nosee: 1, scroll: 1, eval: 1,
  network: 1, response: 1, drag: 2, upload: 2, dialog: 1, trace: 1, perf: 0, heap: 0, lighthouse: 0,
  phone: 0, desktop: 0, dark: 0, light: 0, shot: 0, read: 0, look: 0, back: 0, reload: 0, console: 0, cookies: 0, storage: 0, a11y: 0,
}

export const USAGE = `ui-check [--base URL] [--plan FILE] [--show] [--slow] [--close] <steps…>
  open PATH|URL        go to a page (PATH is joined to --base, default http://localhost:5173)
  click TEXT [N]       a button, link, tab or menu item by its name or text; css=… or role=… work too;
                       when nothing matches, the classifier picks the control TEXT describes. When several
                       match, the one in an open dialog wins, then one not covered, enabled and in view, then
                       the focused form's submit button, then one outside the nav; the line says which.
                       N (or "second TEXT", "last TEXT") picks the Nth match, top to bottom; fill and select take N too
  hover TEXT [N]       as click, without clicking
  fill FIELD VALUE [N] a field by label, placeholder or name (classifier fallback as for click)
  select FIELD OPTION [N]  pick an option in a select
  press KEY            Enter, Escape, Tab, Meta+k…
  drag FROM TO         drag one element onto another (each found as click finds it, or by its text)
  upload TARGET FILE   a file into the file field TARGET names, or through the picker the control TARGET opens;
                       falls back to the page's first file input
  dialog accept|dismiss|TEXT  how this run answers alert, confirm and prompt dialogs from here on (TEXT: accept a
                       prompt with TEXT); without it every dialog is dismissed, and each one is printed
  wait SECONDS|TEXT    sleep, or wait up to 15 s for TEXT to show
  see CLAIM            the classifier checks the screenshot shows CLAIM (fails when it does not)
  nosee CLAIM          the classifier checks the screenshot does not show CLAIM
  look                 the classifier's health look: error, blank or stuck, broken layout
  scroll down|up|TEXT  scroll a screen, or to TEXT
  phone | desktop      390x844 or 1280x800
  dark | light         colour scheme
  read                 print the page's visible text (first 2,000 characters)
  shot                 save a screenshot and print its path
  eval JS              run JS in the page and print the result: an expression, or statements as in the DevTools
                       console (the last one's value, or a top-level return's); promises are awaited
  console              every console message and page error of this run, all levels
  network FILTER       this run's requests (method, status, time, type, URL): FILTER is part of the URL,
                       a type (fetch, xhr, document, script…) or a status (404, failed); "" for all
  response FILTER      the latest response whose URL holds FILTER: status, headers and body (2,000 characters)
  cookies              the page's cookies (name, domain, flags, value length; values never printed)
  storage              localStorage and sessionStorage keys with their values clipped
  a11y                 the accessibility tree of the page (roles and names, 3,000 characters)
  perf                 load timings (TTFB, DOMContentLoaded, load, LCP, CLS), script and layout time since the run
                       began, DOM size, bytes
  heap                 garbage-collect, then a memory snapshot (.heapsnapshot for the DevTools Memory tab) with heap
                       size, DOM nodes and listeners, and the change since this run's last heap
  trace start|stop     a performance trace between the two (a .json for the DevTools Performance panel)
  lighthouse           a Lighthouse audit of the current page (desktop, or mobile at phone width): scores, metrics,
                       the worst audits and the report path; takes 20 to 60 s; keeps the page's storage and sign-in
  back | reload
A plan file has one step per line, quoted like a shell ("…" or '…'), # for comments.
Screenshots, snapshots, traces and reports go to $TMPDIR/agents-ui-check and are deleted after a day.
Chrome runs hidden (headless) and stays open between runs (its own profile, so sign-in is kept). Each session
has a tab of its own, and its runs take turns on it: UI_CHECK_SESSION names the session; by default it is the
Claude Code session (or the calling process) in this project.
--show uses a visible window instead (its own profile and sign-ins); --slow shows it and pauses between
steps so a person can watch; --close closes this session's tab and stops Chrome unless other sessions use it.`

/** Splits one line like a shell would for quoted words: "a b" and 'a b' are one word, \\" escapes. */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue }
      if (ch === quote) { quote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === '#' && !started && cur === '') break
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${line}`)
  if (started) out.push(cur)
  return out
}

/** A plan file's steps, as words. */
export function planWords(text: string): string[] {
  return text.split('\n').flatMap((l) => tokenize(l))
}

/** Words into steps. Throws with the offending word on an unknown verb or a missing argument. */
export function parseSteps(words: readonly string[]): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < words.length;) {
    const verb = words[i]! as Step['verb']
    const arity = VERB_ARITY[verb]
    if (arity === undefined) throw new Error(`unknown step "${words[i]}" (run with --help)`)
    const args = words.slice(i + 1, i + 1 + arity)
    if (args.length < arity) throw new Error(`"${verb}" needs ${arity} ${arity === 1 ? 'word' : 'words'} after it`)
    i += 1 + arity
    // An optional number after a click, hover, fill or select picks the Nth match (no step is a number).
    let nth: number | undefined
    if ((verb === 'click' || verb === 'hover' || verb === 'fill' || verb === 'select') && /^[1-9]\d*$/.test(words[i] ?? '')) nth = Number(words[i++])
    const withNth = nth === undefined ? {} : { nth }
    switch (verb) {
      case 'click': case 'hover': steps.push({ verb, target: args[0]!, ...withNth }); break
      case 'fill': case 'select': steps.push({ verb, target: args[0]!, value: args[1]!, ...withNth }); break
      case 'open': case 'scroll': steps.push({ verb, target: args[0]! }); break
      case 'drag': case 'upload': steps.push({ verb, target: args[0]!, value: args[1]! }); break
      case 'dialog': steps.push({ verb, answer: args[0]! }); break
      case 'trace':
        if (args[0] !== 'start' && args[0] !== 'stop') throw new Error('"trace" takes start or stop')
        steps.push({ verb, action: args[0] })
        break
      case 'press': steps.push({ verb, key: args[0]! }); break
      case 'see': case 'nosee': steps.push({ verb, claim: args[0]! }); break
      case 'eval': steps.push({ verb, script: args[0]! }); break
      case 'network': case 'response': steps.push({ verb, filter: args[0]! }); break
      case 'wait': {
        const n = Number(args[0])
        steps.push(Number.isFinite(n) && args[0]!.trim() !== '' ? { verb, seconds: n } : { verb, text: args[0]! })
        break
      }
      default: steps.push({ verb } as Step)
    }
  }
  return steps
}

/** A path joins the base; a full URL stays as it is. */
export function resolveUrl(target: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target
  return new URL(target.startsWith('/') ? target : `/${target}`, base).href
}

/** Playwright's own selector engines pass straight through. */
export function isSelector(target: string): boolean {
  return /^(css|text|role|xpath|id|data-testid|internal:[a-z-]+)=/.test(target)
}

export function stepLabel(s: Step): string {
  const q = (v: string) => JSON.stringify(v.length > 70 ? `${v.slice(0, 67)}...` : v)
  const n = 'nth' in s && s.nth !== undefined ? ` #${s.nth}` : ''
  switch (s.verb) {
    case 'open': case 'click': case 'hover': case 'scroll': return `${s.verb} ${q(s.target)}${n}`
    case 'fill': case 'select': case 'drag': case 'upload': return `${s.verb} ${q(s.target)} ${q(s.value)}${n}`
    case 'dialog': return `dialog ${q(s.answer)}`
    case 'trace': return `trace ${s.action}`
    case 'press': return `press ${s.key}`
    case 'wait': return 'seconds' in s ? `wait ${s.seconds}s` : `wait ${q(s.text)}`
    case 'see': case 'nosee': return `${s.verb} ${q(s.claim)}`
    case 'eval': return `eval ${q(s.script)}`
    case 'network': case 'response': return `${s.verb} ${q(s.filter)}`
    default: return s.verb
  }
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 }

/** "second Payouts" into 2 and "Payouts"; "3rd row", "last Save" (-1) too. Null when there is no ordinal. */
export function splitOrdinal(target: string): { nth: number; rest: string } | null {
  const m = /^(\w+)\s+(\S.*)$/.exec(target.trim())
  if (!m) return null
  const w = m[1]!.toLowerCase()
  const nth = ORDINALS[w] ?? (/^([1-9]\d*)(st|nd|rd|th)$/.test(w) ? parseInt(w, 10) : undefined)
  return nth === undefined ? null : { nth, rest: m[2]! }
}

/** What the page says about one visible match of a click or fill target. topmost: null when it is out of view. */
export type MatchInfo = {
  enabled: boolean; inViewport: boolean; topmost: boolean | null; inDialog: boolean
  isSubmit: boolean; inFocusedForm: boolean; inNav: boolean
}

const PREFER: ReadonlyArray<[string, (m: MatchInfo) => boolean]> = [
  ['the one in the dialog', (m) => m.inDialog && m.topmost !== false],
  ['the one not covered', (m) => m.topmost !== false],
  ['the enabled one', (m) => m.enabled],
  ['the one in view', (m) => m.inViewport],
  ['the submit button of the focused form', (m) => m.isSubmit && m.inFocusedForm],
  ['the submit button', (m) => m.isSubmit],
  ['the one in the main content', (m) => !m.inNav],
]

/**
 * Which of several matches a person means: each preference in turn narrows the field when some
 * but not all of them have it; the first left (in page order) wins. `why` is the first that decided.
 */
export function rankMatches(ms: readonly MatchInfo[]): { index: number; why: string } {
  let left = ms.map((_, i) => i)
  let why = ''
  for (const [reason, ok] of PREFER) {
    const keep = left.filter((i) => ok(ms[i]!))
    if (keep.length && keep.length < left.length) { left = keep; why ||= reason }
  }
  return { index: left[0] ?? 0, why: why || 'the first' }
}

export const SEE_ID = 'claim'

export function seeQuestion(claim: string): QuickQuestion {
  return {
    id: SEE_ID,
    kind: 'yes_no',
    text: `Look at the screenshot of a web app (image 1); its visible text is the context. Does the screen clearly show this: ${claim}`,
  }
}

/** The health look: each yes is a problem. */
export const LOOK_QUESTIONS: readonly QuickQuestion[] = [
  { id: 'error', kind: 'yes_no', text: 'Does the screenshot (image 1) show an error: a crash screen, a "something went wrong" notice, a failed-to-load message, a raw stack trace or a red error banner?' },
  { id: 'blank', kind: 'yes_no', text: 'Is the screenshot (image 1) blank, or does it show only loading placeholders, skeleton bars or spinners with no real content yet?' },
  { id: 'broken', kind: 'yes_no', text: 'Is the layout in the screenshot (image 1) visibly broken: text or controls overlapping each other, cut off at the screen edge, or unreadable against their background?' },
]

/** A look answer at or above this is reported. */
export const LOOK_WARN_AT = 0.6

export type Verdict = { ok: boolean; note: string }

/** A see or nosee answer into pass or fail. No answer (classifier unavailable) is a fail that says so. */
export function seeVerdict(verb: 'see' | 'nosee', p: number | null): Verdict {
  if (p === null) return { ok: false, note: 'no answer from the classifier' }
  const yes = p >= 0.5
  return { ok: verb === 'see' ? yes : !yes, note: `p ${p.toFixed(2)}` }
}

/** An error screen this sure fails the step; blank and broken stay warnings (a page may still be loading). */
export const LOOK_FAIL_AT = 0.85

export function lookFails(answers: ReadonlyArray<{ id: string; p: number | null }>): boolean {
  return answers.some((a) => a.id === 'error' && a.p !== null && a.p >= LOOK_FAIL_AT)
}

/** The health look's problems, worst first. */
export function lookProblems(answers: ReadonlyArray<{ id: string; p: number | null }>): string[] {
  return answers
    .filter((a) => a.p !== null && a.p >= LOOK_WARN_AT)
    .sort((a, b) => b.p! - a.p!)
    .map((a) => `${a.id} (p ${a.p!.toFixed(2)})`)
}

/** Candidate controls for the classifier fallback, as items it is asked about one by one. */
export type Candidate = { idx: number; tag: string; role: string; name: string; context: string }

export function candidateText(c: Candidate): string {
  return [`${c.tag}${c.role ? ` role=${c.role}` : ''}`, c.name && `name: ${c.name}`, c.context && `near: ${c.context}`].filter(Boolean).join('; ')
}

export function pickQuestion(verb: 'click' | 'hover' | 'fill' | 'select', target: string): QuickQuestion {
  const what = verb === 'fill' || verb === 'select' ? 'the field a person means by' : 'the control a person means by'
  return { id: 'pick', kind: 'yes_no', text: `This item describes one element on a web page. Is it ${what}: "${target}"?` }
}

/** The best candidate at p >= 0.5, or null. */
export function bestCandidate(answers: ReadonlyArray<{ item?: string; p: number | null; value: unknown }>): { idx: number; p: number } | null {
  let best: { idx: number; p: number } | null = null
  for (const a of answers) {
    if (a.item === undefined || a.p === null || a.value !== true) continue
    if (!best || a.p > best.p) best = { idx: Number(a.item), p: a.p }
  }
  return best
}

/** What a dialog step asks for: accept, dismiss, or accept a prompt with this text. */
export function dialogPolicy(answer: string): { accept: boolean; text?: string } {
  if (answer === 'dismiss') return { accept: false }
  if (answer === 'accept') return { accept: true }
  return { accept: true, text: answer }
}

type LhAudit = { title?: string; score?: number | null; scoreDisplayMode?: string; displayValue?: string }
type LhReport = { categories?: Record<string, { title?: string; score?: number | null }>; audits?: Record<string, LhAudit> }

export const LIGHTHOUSE_METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'] as const

/** A Lighthouse JSON report as a few lines: category scores, the main metrics, the worst scored audits. */
export function lighthouseSummary(r: LhReport, worst = 12): string[] {
  const pct = (n: number | null | undefined) => (typeof n === 'number' ? String(Math.round(n * 100)) : '-')
  const lines = [Object.values(r.categories ?? {}).map((c) => `${c.title ?? '?'} ${pct(c.score)}`).join(', ')]
  const metrics = LIGHTHOUSE_METRICS.map((id) => r.audits?.[id]).filter((a): a is LhAudit => !!a?.displayValue).map((a) => `${a.title}: ${a.displayValue}`)
  if (metrics.length) lines.push(metrics.join(', '))
  const bad = Object.values(r.audits ?? {})
    .filter((a) => typeof a.score === 'number' && a.score < 0.9 && (a.scoreDisplayMode === 'binary' || a.scoreDisplayMode === 'numeric' || a.scoreDisplayMode === 'metricSavings'))
    .sort((a, b) => a.score! - b.score!)
    .slice(0, worst)
    .map((a) => `${pct(a.score).padStart(3)}  ${a.title}${a.displayValue ? ` (${a.displayValue})` : ''}`)
  if (bad.length) lines.push('worst audits:', ...bad)
  return lines
}
