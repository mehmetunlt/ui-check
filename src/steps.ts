/**
 * The pure half of ui-check: the step grammar, the plan-file tokenizer, the questions the
 * classifier is asked about a screen, and how answers become pass, fail or warn. No browser, no network.
 */
import type { QuickQuestion } from './classifier/quick-check.ts'

/**
 * The window sizes a check can take, by name: current phones, tablets and monitors. Phones and tablets also turn on
 * touch (one finger, coarse pointer, no hover), so touch-only layouts and 44 px target rules show as on the device.
 * Sizes are CSS pixels (the device's viewport, not its panel).
 */
export const DEVICES = {
  'phone-small': { width: 360, height: 780, touch: true, note: 'a small Android phone' },
  phone: { width: 390, height: 844, touch: true, note: 'a standard iPhone' },
  'phone-large': { width: 430, height: 932, touch: true, note: 'a large iPhone' },
  tablet: { width: 820, height: 1180, touch: true, note: 'an iPad Air, upright' },
  'tablet-landscape': { width: 1180, height: 820, touch: true, note: 'an iPad Air, on its side' },
  desktop: { width: 1280, height: 800, touch: false, note: 'a small laptop (the default)' },
  laptop: { width: 1440, height: 900, touch: false, note: 'a 14 to 15 inch laptop' },
  wide: { width: 1920, height: 1080, touch: false, note: 'a 1080p monitor' },
  qhd: { width: 2560, height: 1440, touch: false, note: 'a 1440p monitor' },
} as const satisfies Record<string, { width: number; height: number; touch: boolean; note: string }>
export type DeviceName = keyof typeof DEVICES
export const isDevice = (verb: string): verb is DeviceName => Object.hasOwn(DEVICES, verb)

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
  | { verb: 'ignore'; pattern: string }
  | { verb: 'cookie'; name: string; value: string }
  | { verb: 'clear-cookies'; domain?: string }
  | { verb: 'network'; filter: string }
  | { verb: 'response'; filter: string }
  | { verb: 'size'; width: number; height: number; touch?: boolean }
  | { verb: 'motion'; reduce: boolean }
  | { verb: 'scale'; factor: number }
  | { verb: 'read'; max?: number }
  | { verb: DeviceName | 'dark' | 'light' | 'shot' | 'look' | 'back' | 'reload' | 'console' | 'cookies' | 'storage' | 'a11y' | 'perf' | 'heap' | 'lighthouse' }

/** How many words each verb takes after it. */
export const VERB_ARITY: Record<Step['verb'], number> = {
  open: 1, click: 1, hover: 1, fill: 2, select: 2, press: 1, wait: 1, see: 1, nosee: 1, scroll: 1, eval: 1,
  network: 1, response: 1, ignore: 1, cookie: 2, 'clear-cookies': 0, drag: 2, upload: 2, dialog: 1, trace: 1, perf: 0, heap: 0, lighthouse: 0,
  size: 1, motion: 1, scale: 1, ...(Object.fromEntries(Object.keys(DEVICES).map((d) => [d, 0])) as Record<DeviceName, 0>), dark: 0, light: 0, shot: 0, read: 0, look: 0, back: 0, reload: 0, console: 0, cookies: 0, storage: 0, a11y: 0,
}

export const USAGE = `ui-check [--base URL] [--plan FILE] [--show] [--slow] [--close] <steps…>
  open PATH|URL        go to a page (PATH is joined to --base, default http://localhost:5173)
  click TEXT [N]       a button, link, tab or menu item by its name or text; css=… or role=… work too;
                       when nothing matches, the classifier picks the control TEXT describes. When several
                       match, the one in an open dialog wins, then one not covered, enabled and in view, then
                       the focused form's submit button, then one outside the nav; the line says which.
                       N (or "second TEXT", "last TEXT") picks the Nth match, top to bottom; fill and select take N too
  hover TEXT [N]       as click, without clicking
  fill FIELD VALUE [N] a field (input, textarea, contenteditable) by its label (wired, wrapping, aria-labelledby or
                       the text just before it), placeholder or name (classifier fallback as for click)
  select FIELD OPTION [N]  pick an option in a native select, or in a custom dropdown: opens it, types OPTION into
                       its search box when one shows, then clicks the option by its name or text
  press KEY            Enter, Escape, Tab, Meta+k…
  drag FROM TO         drag one element onto another (each found as click finds it, or by its text)
  upload TARGET FILE   a file into the file field TARGET names, or through the picker the control TARGET opens;
                       falls back to the page's first file input
  dialog accept|dismiss|TEXT  how this run answers alert, confirm and prompt dialogs from here on (TEXT: accept a
                       prompt with TEXT); without it every dialog is dismissed, and each one is printed
  wait SECONDS|TEXT    sleep, or wait up to 15 s for TEXT to show
  see CLAIM            the classifier checks the screenshot and visible text show CLAIM (fails when they do not);
                       it waits for the page to settle first (up to 2 s) and asks once more when the answer fails
  nosee CLAIM          the classifier checks the screenshot does not show CLAIM
  look                 the classifier's health look: error, blank or stuck, broken layout (the Next.js dev
                       indicator is hidden for it, unless its error dialog is open)
  scroll down|up|TEXT  scroll a screen, or to TEXT
  phone-small | phone | phone-large   360x780, 390x844, 430x932, with touch
  tablet | tablet-landscape           820x1180 or 1180x820, with touch
  desktop | laptop | wide | qhd       1280x800 (the default), 1440x900, 1920x1080 (1080p), 2560x1440
  size WxH [touch]     any window size, e.g. size 1600x1000, or a width alone (size 1440 is 1440x900); "touch"
                       after it turns touch on
  motion reduce|normal prefers-reduced-motion for the page, from here on
  scale 1|2|3          device pixel ratio for sharp screenshots (a retina screen), until the next size step
  dark | light         colour scheme
  read [N]             print the page's visible text (first 2,000 characters, or N)
  shot                 save a screenshot and print its path
  eval JS|@FILE        run JS in the page and print the result: an expression, or statements as in the DevTools
                       console (the last one's value, or a top-level return's); promises are awaited. @FILE
                       reads the script from a file, so quotes and newlines need no shell escaping
  ignore TEXT|STATUS   from here on, console errors, page errors and responses whose text or URL holds TEXT
                       (any case, * as a wildcard) print as info instead of warn or fail: expected noise. A bare
                       status number (ignore 404) quiets everything that carries that status, including
                       "Failed to load resource" console errors and page errors on a page that answered 404
  console              every console message and page error of this run, all levels
  network FILTER       this run's requests (method, status, time, type, URL): FILTER is part of the URL,
                       a type (fetch, xhr, document, script…) or a status (404, failed); "" for all
  response FILTER      the latest response whose URL holds FILTER: status, headers and body (2,000 characters)
  cookies              the page's cookies (name, domain, flags, value length; values never printed)
  cookie NAME VALUE    set a cookie for the current page's site through the browser (not document.cookie), so
                       it can replace an httpOnly one, whose flags it keeps; the value is never printed
  clear-cookies [DOMAIN]  delete all cookies, or those of DOMAIN and its subdomains (the profile is shared, so
                       this signs every session out of that site)
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

/**
 * Splits one line like a shell would for quoted words: "a b" and 'a b' are one word, \\" escapes.
 * Inside a css=, role= or other selector word the quotes belong to the selector, not to the shell,
 * so `click css=[aria-label="Show details"]` keeps both quotes and the space between them.
 */
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
    if ((ch === '"' || ch === "'") && isSelector(cur)) {
      const end = line.indexOf(ch, i + 1)
      if (end < 0) throw new Error(`unclosed ${ch} in: ${line}`)
      cur += line.slice(i, end + 1)
      i = end
      started = true
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
    // read takes a character count the same way.
    let max: number | undefined
    if (verb === 'read' && /^[1-9]\d*$/.test(words[i] ?? '')) max = Number(words[i++])
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
      case 'ignore': steps.push({ verb, pattern: args[0]! }); break
      case 'cookie': steps.push({ verb, name: args[0]!, value: args[1]! }); break
      case 'clear-cookies': {
        // An optional domain: the next word, when it looks like one and is not a step.
        const d = words[i]
        if (d !== undefined && !(d in VERB_ARITY) && /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(d)) { steps.push({ verb, domain: d }); i++ }
        else steps.push({ verb })
        break
      }
      case 'network': case 'response': steps.push({ verb, filter: args[0]! }); break
      case 'read': steps.push(max === undefined ? { verb } : { verb, max }); break
      case 'size': {
        // A width alone keeps the laptop's 16:10, so `size 1440` is 1440x900.
        const m = /^(\d{3,4})(?:x(\d{3,4}))?$/.exec(args[0]!)
        const width = m ? Number(m[1]) : 0
        const height = m ? (m[2] ? Number(m[2]) : Math.round((width * 10) / 16)) : 0
        if (!m || width < 200 || height < 200) throw new Error(`"size" needs WIDTHxHEIGHT, each 200 or more, e.g. 1920x1080 or 1440 (got "${args[0]}")`)
        const touch = words[i] === 'touch'
        if (touch) i++
        steps.push({ verb, width, height, ...(touch ? { touch } : {}) })
        break
      }
      case 'scale': {
        const f = Number(args[0])
        if (!(f === 1 || f === 2 || f === 3)) throw new Error(`"scale" needs 1, 2 or 3 (got "${args[0]}")`)
        steps.push({ verb, factor: f })
        break
      }
      case 'motion':
        if (args[0] !== 'reduce' && args[0] !== 'normal') throw new Error(`"motion" needs reduce or normal (got "${args[0]}")`)
        steps.push({ verb, reduce: args[0] === 'reduce' })
        break
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
    case 'size': return `size ${s.width}x${s.height}${s.touch ? ' touch' : ''}`
    case 'motion': return `motion ${s.reduce ? 'reduce' : 'normal'}`
    case 'scale': return `scale ${s.factor}`
    case 'wait': return 'seconds' in s ? `wait ${s.seconds}s` : `wait ${q(s.text)}`
    case 'see': case 'nosee': return `${s.verb} ${q(s.claim)}`
    case 'eval': return `eval ${q(s.script)}`
    case 'ignore': return `ignore ${q(s.pattern)}`
    case 'cookie': return `cookie ${q(s.name)} (value ${s.value.length} chars)`
    case 'clear-cookies': return s.domain ? `clear-cookies ${q(s.domain)}` : 'clear-cookies'
    case 'network': case 'response': return `${s.verb} ${q(s.filter)}`
    case 'read': return s.max === undefined ? 'read' : `read ${s.max}`
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

/** The ignore pattern a warning matches, if any: part of the text, any case, * for anything. */
export function ignoredBy(patterns: readonly string[], ...texts: string[]): string | undefined {
  return patterns.find((p) => {
    const re = new RegExp(p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i')
    return texts.some((t) => re.test(t))
  })
}

/** `ignore 404`: a bare status number quiets whatever carries that status, whatever the words say. */
export function ignoredStatus(patterns: readonly string[], status: number | undefined): string | undefined {
  if (status === undefined) return undefined
  return patterns.find((p) => /^\d{3}$/.test(p) && Number(p) === status)
}

/** The status Chrome puts in "Failed to load resource: the server responded with a status of 404 (Not Found)". */
export function statusIn(text: string): number | undefined {
  const m = /status of (\d{3})/.exec(text)
  return m ? Number(m[1]) : undefined
}

/**
 * The line under a click or fill that found nothing: what was looked at, so the next try can be narrower.
 * It starts with the old words ("nothing matches", "no such field") so existing habits still read.
 */
export function noMatchNote(o: { fields?: boolean; selector?: boolean; considered: number }): string {
  const noun = o.fields ? 'fields' : 'controls'
  if (o.selector && o.considered === 0) return 'nothing matches; no element matches that selector'
  // A selector that matched but shows nothing is the common trap: the element is there, hidden or 0x0.
  if (o.selector) return `nothing matches; the selector matched ${o.considered} ${o.considered === 1 ? 'element' : 'elements'}, none of them visible`
  const saw = o.considered ? `looked at ${o.considered} visible ${o.considered === 1 ? noun.slice(0, -1) : noun}` : `no visible ${noun} to look at`
  return `${o.fields ? 'no such field' : 'nothing matches'}; ${saw}, css=… or role=… reaches anything the words miss`
}

/** Text that means the page is an error screen, though it rendered. */
const ERROR_SCREEN = /application error: a (client|server)-side exception|unhandled runtime error|internal server error|this page could not be found/i

/**
 * Page errors fail a step unless it loaded a document with a 2xx and the page still rendered
 * (some text or media, not an error screen): then they are warnings, like a failed side request.
 */
export function pageErrorsFail(o: { docStatus: number | null; textChars: number; media: number; text: string }): boolean {
  if (o.docStatus === null || o.docStatus < 200 || o.docStatus >= 300) return true
  if (o.textChars === 0 && o.media === 0) return true
  return ERROR_SCREEN.test(o.text)
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

/**
 * A see or nosee that failed is asked once more after the page settles (a screenshot taken before
 * paint, right after a client-side navigation, is the usual false fail). No answer is not retried.
 */
export async function judgeWithRetry(verb: 'see' | 'nosee', once: () => Promise<number | null>, settle: () => Promise<void>): Promise<Verdict> {
  const first = seeVerdict(verb, await once())
  if (first.ok || first.note === seeVerdict(verb, null).note) return first
  await settle()
  const again = seeVerdict(verb, await once())
  return { ok: again.ok, note: `${first.note}, then ${again.note} after the page settled` }
}

/** Visible text for the classifier: whitespace squeezed, blank runs and repeated lines dropped, cut at a line end. */
export function tidyText(text: string, max = 4_000): string {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim()
    const prev = out.at(-1)
    if (line === '' ? prev === '' || prev === undefined : line === prev || (prev === '' && line === out.at(-2))) continue
    out.push(line)
  }
  while (out.at(-1) === '') out.pop()
  const all = out.join('\n')
  if (all.length <= max) return all
  const cut = all.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return nl > max * 0.8 ? cut.slice(0, nl) : cut
}

/** The Next.js dev indicator and build badge, as the judged screenshot hides them. */
export const NEXT_DEV_SELECTORS = ['nextjs-portal', '#__next-build-watcher', '#__next-prerender-indicator', '[data-nextjs-toast]', '[data-next-badge-root]'] as const

/**
 * CSS for the judged screenshot: the Next.js dev indicator and build badge are hidden unless its error
 * dialog is open, and Vite's error overlay only when this run saw no error (a stale one). Only what is on the
 * page: on a page with none of them the style is empty and none is added, so a site's Content Security
 * Policy never logs a blocked inline style for the check itself (`nextPresent` left out counts as present).
 */
export function devOverlayStyle(o: { nextDialog: boolean; viteOverlay: boolean; sawErrors: boolean; nextPresent?: boolean }): string {
  const hide: string[] = o.nextDialog || o.nextPresent === false ? [] : [...NEXT_DEV_SELECTORS]
  if (o.viteOverlay && !o.sawErrors) hide.push('vite-error-overlay')
  return hide.length ? `${hide.join(', ')} { display: none !important; }` : ''
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

/**
 * A look that only warns: what it judged, and why a warn is not a failure. A screenshot that ends
 * mid-band (content continues below the fold) is read as broken, so scrolling and looking again is the check.
 */
export function lookWarnNote(answers: ReadonlyArray<{ id: string; p: number | null }>): string {
  const problems = lookProblems(answers).map((p) => (p.startsWith('broken')
    ? p.replace(/\)$/, ', a screenshot cut by the viewport reads as broken; scroll and look again)')
    : p))
  return `WARN ${problems.join(', ')}`
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
