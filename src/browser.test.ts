/**
 * ui-check against small pages served here, in a Chrome of its own (UI_CHECK_STATE, UI_CHECK_PORT),
 * so it never touches the shared one. No classifier: OPENROUTER_API_KEY is blanked.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p))
const skip = CHROME ? false : 'no Chrome'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const page = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>t</title><link rel="icon" href="data:,">${head}</head><body>${body}</body></html>`
type Handler = (req: IncomingMessage, res: ServerResponse) => void
const html = (body: string, head?: string): Handler => (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(body, head)) }

const HIT = '<script>window.hit = (w) => { document.body.dataset.hit = w }</script>'

const ROUTES: Record<string, Handler> = {
  '/a': html('<h1>Page A</h1>'),
  '/b': html('<h1>Page B</h1>'),
  // The tab heading comes first and is a plain button, as in many component kits.
  '/login': html(`${HIT}<div><button type="button" onclick="hit('tab')">Login</button><button type="button">Register</button></div>
    <form onsubmit="hit('submit'); return false"><input aria-label="Email"><button>Login</button></form>`),
  '/payouts': html(`${HIT}<nav><a href="#p" onclick="hit('nav')">Payouts</a><a href="#e">Earnings</a></nav>
    <main><div role="tablist"><button role="tab" onclick="hit('tab')">Overview</button><button role="tab" onclick="hit('tab')">Payouts</button></div></main>`),
  // Rendered fine, but a script throws (a failed server action in a Next.js layout, say) and a side request 503s.
  '/noisy': html(`<h1>Earnings</h1><p>All good here</p><script>fetch('/api/flaky'); setTimeout(() => { throw new Error('An error occurred in the Server Components render') })</script>`),
  '/api/flaky': (_req, res) => { res.writeHead(503); res.end('busy') },
  '/blank-error': html("<script>throw new Error('boom')</script>"),
  '/app-error': html("<h2>Application error: a client-side exception has occurred</h2><script>throw new Error('boom')</script>"),
  '/click-error': html(`<button onclick="throw new Error('handler broke')">Go</button>`),
  '/set': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'tok=old; HttpOnly; Path=/' }); res.end(page('<h1>Signed in</h1>')) },
  '/whoami': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(/(?:^|; )tok=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '') },
  // Fields labelled every way forms do it, not all of them wired up.
  '/fields': html(`<div><label>Reason</label><textarea id="f1"></textarea></div>
    <div class="field"><div class="label">Internal memo <span>*</span></div><div class="wrap"><textarea id="f2"></textarea></div></div>
    <div><span id="nl">Notes</span><div id="f3" contenteditable="true" aria-labelledby="nl" style="min-height:20px"></div></div>
    <p>Bio</p><div id="f4" contenteditable="true" style="min-height:20px"></div>
    <label>Comment <textarea id="f5"></textarea></label>`),
  // Custom dropdowns: an ARIA combobox, a searchable one of plain divs, a plain div menu, and a native select.
  '/selects': html(`<script>window.picked = {}
    function pop(id, show) { document.getElementById(id).hidden = !show }
    </script>
    <div><label id="cl">Country</label>
      <button role="combobox" aria-labelledby="cl" aria-haspopup="listbox" onclick="pop('cl-list', true)">Choose</button>
      <ul role="listbox" id="cl-list" hidden><li role="option" onclick="picked.country = 'Turkey'; pop('cl-list')">Turkey</li><li role="option" onclick="picked.country = 'Germany'; pop('cl-list')">Germany</li></ul></div>
    <div><div>City</div><div class="select" tabindex="0" onclick="pop('city-pop', true); document.getElementById('city-q').focus()">Select…</div>
      <div id="city-pop" hidden><input id="city-q" placeholder="Search" oninput="filter(this.value)"><div id="city-list"></div></div></div>
    <script>const CITIES = ['Ankara', 'Istanbul', 'Izmir', 'Bursa', 'Antalya', 'Trabzon']
      function filter(q) { document.getElementById('city-list').innerHTML = CITIES.filter((c) => c.toLowerCase().includes(q.toLowerCase())).slice(0, 3)
        .map((c) => '<div onclick="picked.city = \\'' + c + '\\'; pop(\\'city-pop\\')">' + c + '</div>').join('') }
      filter('')</script>
    <div><label>Status</label><div class="dropdown-trigger" onclick="pop('st-menu', true)">Pending</div>
      <div id="st-menu" hidden><div onclick="picked.status = 'Approved'; pop('st-menu')">Approved</div><div onclick="picked.status = 'Rejected'; pop('st-menu')">Rejected</div></div></div>
    <label>Size <select onchange="picked.size = this.value"><option>S</option><option>M</option></select></label>`),
  '/upload': html(`<label for="f">Attach</label><input type="file" id="f" onchange="document.body.dataset.hit = this.files[0].name">`),
  // An open side panel over the page, with a backdrop.
  '/panel': html(`${HIT}<main><button onclick="hit('page')">Add adjustment</button></main>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>
    <div role="dialog" aria-modal="true" style="position:fixed;top:0;right:0;bottom:0;width:360px;background:#fff">
      <form onsubmit="hit('panel'); return false"><textarea aria-label="Note"></textarea><button>Add adjustment</button></form></div>`),
}

let state = ''
let port = 0
let server: Server
let base = ''

async function freePort(): Promise<number> {
  const s = netServer().listen(0, '127.0.0.1')
  await new Promise((r) => s.once('listening', r))
  const p = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}

before(async () => {
  if (skip) return
  state = mkdtempSync(join(tmpdir(), 'ui-check-test-'))
  port = await freePort()
  server = createServer((req, res) => {
    const h = ROUTES[new URL(req.url ?? '/', 'http://x').pathname]
    if (h) return h(req, res)
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end(page('<h1>Not found</h1>'))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (skip) return
  server.close()
  const pidFile = join(state, 'chrome-hidden.pid')
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try { process.kill(pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0) } catch { break }
      await sleep(100)
    }
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 5 })
})

/** One ui-check run from source; resolves with its exit code and output. */
function uiCheck(args: string[], session = 'test'): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--base', base, ...args], {
      cwd: REPO,
      env: { ...process.env, UI_CHECK_STATE: state, UI_CHECK_PORT: String(port), UI_CHECK_SESSION: session, OPENROUTER_API_KEY: '' },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

/** The lines a step printed under itself (eval, read and the like). */
const printed = (out: string) => out.split('\n').filter((l) => l.startsWith('     ')).map((l) => l.slice(5))

test('each session drives its own tab', { skip }, async () => {
  await uiCheck(['open', '/a'], 'one')
  await uiCheck(['open', '/b'], 'two')
  const r = await uiCheck(['eval', 'location.pathname'], 'one')
  assert.deepEqual(printed(r.out), ['/a'], r.out)
})

test('two runs of one session take turns on its tab', { skip }, async () => {
  const slow = uiCheck(['open', '/a', 'wait', '3', 'eval', 'location.pathname'], 'three')
  await sleep(1_500)
  const other = uiCheck(['open', '/b'], 'three')
  const [r] = await Promise.all([slow, other])
  assert.deepEqual(printed(r.out), ['/a'], r.out)
  const next = await uiCheck(['eval', 'location.pathname'], 'three')
  assert.deepEqual(printed(next.out), ['/b'], next.out)
})

const hitAfter = async (path: string, steps: string[]) => {
  const r = await uiCheck(['open', path, ...steps, 'eval', 'document.body.dataset.hit'])
  return { hit: printed(r.out).at(-1), out: r.out }
}

test('click prefers the submit button over a tab of the same name', { skip }, async () => {
  const r = await hitAfter('/login', ['fill', 'Email', 'a@b.test', 'click', 'Login'])
  assert.equal(r.hit, 'submit', r.out)
  assert.match(r.out, /click "Login" {2}name \(2 matches, chose the submit button of the focused form\)/)
})

test('click prefers the tab in the page over the sidebar link', { skip }, async () => {
  const r = await hitAfter('/payouts', ['click', 'Payouts'])
  assert.equal(r.hit, 'tab', r.out)
  assert.match(r.out, /2 matches, chose the one in the main content/)
})

test('click prefers the open panel over the page behind it', { skip }, async () => {
  const r = await hitAfter('/panel', ['click', 'Add adjustment'])
  assert.equal(r.hit, 'panel', r.out)
  assert.match(r.out, /chose the one in the dialog/)
})

test('an ordinal picks the match, top to bottom', { skip }, async () => {
  assert.equal((await hitAfter('/payouts', ['click', 'Payouts', '1'])).hit, 'nav')
  const r = await hitAfter('/payouts', ['click', 'second Payouts'])
  assert.equal(r.hit, 'tab', r.out)
  assert.match(r.out, /2 matches, chose #2/)
})

test('eval runs expressions, statements and function bodies, awaiting promises, each once', { skip }, async () => {
  const r = await uiCheck(['open', '/a',
    'eval', "document.cookie='a=b; path=/'; 'set'",
    'eval', 'const x = 2; x * 3',
    'eval', "await new Promise((r) => setTimeout(r, 50)); 'waited'",
    'eval', 'const r = [1, 2].map((x) => { return x * 2 }); r.length',
    'eval', "if (document.title) { return 'early' } return 'late'",
    'eval', "fetch('/a').then((r) => r.status)",
    'eval', "window.n = (window.n || 0) + 1; JSON.parse('{')",
    'eval', 'window.n',
  ])
  assert.deepEqual(printed(r.out), ['set', '6', 'waited', '2', 'early', '200', '1'], r.out)
  assert.match(r.out, /FAIL eval "window\.n = .*SyntaxError|FAIL eval "window\.n = .*JSON/)
})

test('open warns, not fails, on page errors when the page loaded and rendered', { skip }, async () => {
  const r = await uiCheck(['open', '/noisy'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ok {3}open "\/noisy"/m)
  assert.match(r.out, /^warn page error: An error occurred in the Server Components render/m)
  assert.match(r.out, /^warn 503 GET \/api\/flaky/m)
})

test('page errors still fail on a blank page, an error screen and an action', { skip }, async () => {
  for (const steps of [['open', '/blank-error'], ['open', '/app-error'], ['open', '/click-error', 'click', 'Go']]) {
    const r = await uiCheck(steps)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^FAIL .*page error: (boom|handler broke)/m)
  }
})

test('ignore turns matching errors and responses into info for the rest of the run', { skip }, async () => {
  const r = await uiCheck(['ignore', 'Server Components', 'ignore', '/api/*', 'open', '/noisy'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /^warn/m)
  assert.match(r.out, /^info ignored: page error: An error occurred/m)
  assert.match(r.out, /^info ignored: 503 GET \/api\/flaky/m)
  assert.match(r.out, /0 warnings/)
})

test('cookie sets one for the page (an httpOnly one keeps its flags) and clear-cookies clears them', { skip }, async () => {
  const whoami = "fetch('/whoami').then((r) => r.text())"
  const r = await uiCheck(['clear-cookies', 'open', '/set', 'cookie', 'tok', 'n3w-v4lue', 'eval', whoami, 'cookie', 'extra', 'x1', 'eval', 'document.cookie', 'cookies',
    'clear-cookies', 'example.com', 'eval', whoami, 'clear-cookies', 'eval', whoami])
  assert.equal(r.code, 0, r.out)
  const lines = printed(r.out)
  assert.deepEqual([lines[0], lines[1]], ['n3w-v4lue', 'extra=x1'], r.out)
  assert.match(r.out, /^ {5}tok .*httpOnly/m)
  assert.doesNotMatch(r.out.replace(/^ {5}n3w-v4lue$/gm, ''), /n3w-v4lue/)
  assert.match(r.out, /clear-cookies "example\.com" {2}0 cleared/)
  assert.match(r.out, /clear-cookies {2}2 cleared/)
  assert.deepEqual(lines.slice(-2), ['n3w-v4lue', ''], r.out)
})

test('fill finds textareas and contenteditables by wired, wrapping, nearby and aria-labelledby labels', { skip }, async () => {
  const r = await uiCheck(['open', '/fields', 'fill', 'Reason', 'r', 'fill', 'Internal memo', 'm', 'fill', 'Notes', 'n', 'fill', 'Bio', 'b', 'fill', 'Comment', 'c',
    'eval', "[f1.value, f2.value, f3.innerText, f4.innerText, f5.value].join('|')"])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(printed(r.out), ['r|m|n|b|c'], r.out)
})

test('select drives custom dropdowns: opens, searches, clicks the option; native selects as before', { skip }, async () => {
  const r = await uiCheck(['open', '/selects', 'select', 'Country', 'Germany', 'select', 'City', 'Trabzon', 'select', 'Status', 'Rejected', 'select', 'Size', 'M',
    'eval', 'JSON.stringify(picked)'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(JSON.parse(printed(r.out).at(-1) ?? '{}'), { country: 'Germany', city: 'Trabzon', status: 'Rejected', size: 'M' }, r.out)
  assert.match(r.out, /select "City" "Trabzon" .*typed/)
})

test('upload sets a file field it finds directly', { skip }, async () => {
  const r = await uiCheck(['open', '/upload', 'upload', 'Attach', 'package.json', 'eval', 'document.body.dataset.hit'])
  assert.match(r.out, /upload "Attach" "package\.json" {2}name, file field/, r.out)
  assert.deepEqual(printed(r.out), ['package.json'], r.out)
})
