import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestCandidate, ignoredBy, pageErrorsFail, dialogPolicy, isSelector, lighthouseSummary, lookFails, lookProblems, parseSteps, planWords, rankMatches, resolveUrl, seeVerdict, splitOrdinal, stepLabel, tokenize, type MatchInfo } from './steps.ts'

test('tokenize keeps quoted words whole and stops at a comment', () => {
  assert.deepEqual(tokenize(`fill "Message" 'hi there'  # say hi`), ['fill', 'Message', 'hi there'])
  assert.deepEqual(tokenize('see "a \\"quoted\\" word"'), ['see', 'a "quoted" word'])
  assert.deepEqual(tokenize('click ""'), ['click', ''])
  assert.deepEqual(tokenize('# only a comment'), [])
  assert.throws(() => tokenize('see "open'), /unclosed/)
})

test('a plan file is one step per line', () => {
  const steps = parseSteps(planWords('open /home\n\n# hire someone\nclick Hire\nwait 2\nwait "Saved"\nsee "a list of agents"\nphone\n'))
  assert.deepEqual(steps, [
    { verb: 'open', target: '/home' },
    { verb: 'click', target: 'Hire' },
    { verb: 'wait', seconds: 2 },
    { verb: 'wait', text: 'Saved' },
    { verb: 'see', claim: 'a list of agents' },
    { verb: 'phone' },
  ])
})

test('inspection steps parse', () => {
  assert.deepEqual(parseSteps(['console', 'network', '/api', 'response', '/api/me', 'cookies', 'storage', 'a11y']), [
    { verb: 'console' }, { verb: 'network', filter: '/api' }, { verb: 'response', filter: '/api/me' }, { verb: 'cookies' }, { verb: 'storage' }, { verb: 'a11y' },
  ])
})

test('drag, upload, dialog, trace and the audits parse; trace takes start or stop', () => {
  assert.deepEqual(parseSteps(['drag', 'Card 1', 'Done', 'upload', 'Attach', './a.png', 'dialog', 'accept', 'trace', 'start', 'perf', 'heap', 'lighthouse', 'trace', 'stop']), [
    { verb: 'drag', target: 'Card 1', value: 'Done' }, { verb: 'upload', target: 'Attach', value: './a.png' }, { verb: 'dialog', answer: 'accept' },
    { verb: 'trace', action: 'start' }, { verb: 'perf' }, { verb: 'heap' }, { verb: 'lighthouse' }, { verb: 'trace', action: 'stop' },
  ])
  assert.throws(() => parseSteps(['trace', 'go']), /start or stop/)
})

test('dialogPolicy: accept, dismiss, or a prompt answer', () => {
  assert.deepEqual(dialogPolicy('accept'), { accept: true })
  assert.deepEqual(dialogPolicy('dismiss'), { accept: false })
  assert.deepEqual(dialogPolicy('Ada'), { accept: true, text: 'Ada' })
})

test('lighthouseSummary: scores, metrics, worst scored audits first, informative ones left out', () => {
  const lines = lighthouseSummary({
    categories: { performance: { title: 'Performance', score: 0.72 }, accessibility: { title: 'Accessibility', score: 1 } },
    audits: {
      'largest-contentful-paint': { title: 'Largest Contentful Paint', score: 0.5, scoreDisplayMode: 'numeric', displayValue: '3.1 s' },
      'color-contrast': { title: 'Contrast', score: 0, scoreDisplayMode: 'binary' },
      'diagnostics': { title: 'Diagnostics', score: null, scoreDisplayMode: 'informative' },
      'fine': { title: 'Fine', score: 1, scoreDisplayMode: 'binary' },
    },
  })
  assert.deepEqual(lines, ['Performance 72, Accessibility 100', 'Largest Contentful Paint: 3.1 s', 'worst audits:', '  0  Contrast', ' 50  Largest Contentful Paint (3.1 s)'])
})

test('parseSteps names an unknown verb and a missing argument', () => {
  assert.throws(() => parseSteps(['tap', 'x']), /unknown step "tap"/)
  assert.throws(() => parseSteps(['fill', 'Message']), /"fill" needs 2 words/)
})

test('resolveUrl joins paths to the base and keeps full URLs', () => {
  assert.equal(resolveUrl('/home', 'http://localhost:5173'), 'http://localhost:5173/home')
  assert.equal(resolveUrl('settings', 'http://localhost:5173/x'), 'http://localhost:5173/settings')
  assert.equal(resolveUrl('https://example.com/a', 'http://localhost:5173'), 'https://example.com/a')
})

test('selectors pass through; plain words do not', () => {
  assert.equal(isSelector('css=.send'), true)
  assert.equal(isSelector('role=button[name="Send"]'), true)
  assert.equal(isSelector('Send'), false)
})

test('see passes on yes, nosee on no, and no answer fails', () => {
  assert.deepEqual(seeVerdict('see', 0.91), { ok: true, note: 'p 0.91' })
  assert.equal(seeVerdict('see', 0.2).ok, false)
  assert.equal(seeVerdict('nosee', 0.2).ok, true)
  assert.equal(seeVerdict('nosee', 0.7).ok, false)
  assert.deepEqual(seeVerdict('see', null), { ok: false, note: 'no answer from the classifier' })
})

test('look reports answers at or above the bar, worst first', () => {
  assert.deepEqual(lookProblems([{ id: 'error', p: 0.1 }, { id: 'blank', p: 0.65 }, { id: 'broken', p: 0.9 }, { id: 'x', p: null }]), ['broken (p 0.90)', 'blank (p 0.65)'])
})

test('only a sure error screen fails the look', () => {
  assert.equal(lookFails([{ id: 'error', p: 0.9 }]), true)
  assert.equal(lookFails([{ id: 'error', p: 0.7 }, { id: 'blank', p: 0.99 }]), false)
})

test('bestCandidate takes the likeliest yes', () => {
  assert.deepEqual(bestCandidate([{ item: '0', p: 0.3, value: false }, { item: '3', p: 0.8, value: true }, { item: '5', p: 0.6, value: true }]), { idx: 3, p: 0.8 })
  assert.equal(bestCandidate([{ item: '0', p: 0.4, value: false }]), null)
})

test('stepLabel clips long words', () => {
  assert.equal(stepLabel({ verb: 'press', key: 'Enter' }), 'press Enter')
  assert.match(stepLabel({ verb: 'see', claim: 'x'.repeat(100) }), /^see "x{67}\.\.\."$/)
})

test('a number after click, hover, fill or select picks that match', () => {
  assert.deepEqual(parseSteps(['click', 'Payouts', '2', 'hover', 'Menu', 'fill', 'Amount', '50', '3', 'select', 'Size', 'M', 'open', '/x']), [
    { verb: 'click', target: 'Payouts', nth: 2 }, { verb: 'hover', target: 'Menu' }, { verb: 'fill', target: 'Amount', value: '50', nth: 3 },
    { verb: 'select', target: 'Size', value: 'M' }, { verb: 'open', target: '/x' },
  ])
  assert.equal(stepLabel({ verb: 'click', target: 'Payouts', nth: 2 }), 'click "Payouts" #2')
  assert.throws(() => parseSteps(['click', 'Payouts', '0']), /unknown step "0"/)
})

test('splitOrdinal reads "second Payouts", "3rd row" and "last Save"', () => {
  assert.deepEqual(splitOrdinal('second Payouts'), { nth: 2, rest: 'Payouts' })
  assert.deepEqual(splitOrdinal('3rd row'), { nth: 3, rest: 'row' })
  assert.deepEqual(splitOrdinal('Last Save'), { nth: -1, rest: 'Save' })
  assert.equal(splitOrdinal('Payouts'), null)
  assert.equal(splitOrdinal('second'), null)
})

const m = (o: Partial<MatchInfo>): MatchInfo => ({ enabled: true, inViewport: true, topmost: true, inDialog: false, isSubmit: false, inFocusedForm: false, inNav: false, ...o })

test('rankMatches: the dialog, the uncovered, the usable, the submit button, the main content, in that order', () => {
  assert.deepEqual(rankMatches([m({}), m({ inDialog: true })]), { index: 1, why: 'the one in the dialog' })
  assert.deepEqual(rankMatches([m({ topmost: false }), m({})]), { index: 1, why: 'the one not covered' })
  assert.deepEqual(rankMatches([m({ inDialog: true, topmost: false }), m({ inDialog: true })]), { index: 1, why: 'the one in the dialog' })
  assert.deepEqual(rankMatches([m({ enabled: false }), m({})]), { index: 1, why: 'the enabled one' })
  assert.deepEqual(rankMatches([m({ inViewport: false, topmost: null }), m({})]), { index: 1, why: 'the one in view' })
  assert.deepEqual(rankMatches([m({}), m({ isSubmit: true }), m({ isSubmit: true, inFocusedForm: true })]), { index: 2, why: 'the submit button of the focused form' })
  assert.deepEqual(rankMatches([m({}), m({ isSubmit: true })]), { index: 1, why: 'the submit button' })
  assert.deepEqual(rankMatches([m({ inNav: true }), m({})]), { index: 1, why: 'the one in the main content' })
  assert.deepEqual(rankMatches([m({}), m({})]), { index: 0, why: 'the first' })
})

test('ignore parses; its pattern matches text anywhere, any case, with * as a wildcard', () => {
  assert.deepEqual(parseSteps(['ignore', '/api/flaky', 'open', '/']), [{ verb: 'ignore', pattern: '/api/flaky' }, { verb: 'open', target: '/' }])
  assert.equal(ignoredBy(['server components'], 'page error: An error occurred in the Server Components render'), 'server components')
  assert.equal(ignoredBy(['/api/*/status'], '503 GET /api/v1/status'), '/api/*/status')
  assert.equal(ignoredBy(['/api/*/status'], '503 GET /api/v1/other'), undefined)
  assert.equal(ignoredBy(['a.b'], 'axb'), undefined)
  assert.equal(ignoredBy([], 'x'), undefined)
})

test('page errors fail unless the document loaded with a 2xx and the page rendered', () => {
  const ok = { docStatus: 200, textChars: 120, media: 0, text: 'Earnings this month' }
  assert.equal(pageErrorsFail(ok), false)
  assert.equal(pageErrorsFail({ ...ok, docStatus: null }), true)
  assert.equal(pageErrorsFail({ ...ok, docStatus: 500 }), true)
  assert.equal(pageErrorsFail({ ...ok, textChars: 0, text: '' }), true)
  assert.equal(pageErrorsFail({ ...ok, textChars: 0, text: '', media: 2 }), false)
  assert.equal(pageErrorsFail({ ...ok, text: 'Application error: a client-side exception has occurred (see the browser console)' }), true)
})

test('cookie and clear-cookies parse; a domain after clear-cookies is optional; the value is never shown', () => {
  assert.deepEqual(parseSteps(['cookie', 'sid', 's3cret', 'clear-cookies', 'example.com', 'clear-cookies', 'open', '/', 'clear-cookies']), [
    { verb: 'cookie', name: 'sid', value: 's3cret' }, { verb: 'clear-cookies', domain: 'example.com' }, { verb: 'clear-cookies' }, { verb: 'open', target: '/' }, { verb: 'clear-cookies' },
  ])
  assert.equal(stepLabel({ verb: 'cookie', name: 'sid', value: 's3cret' }), 'cookie "sid" (value 6 chars)')
  assert.equal(stepLabel({ verb: 'clear-cookies', domain: '.example.com' }), 'clear-cookies ".example.com"')
})
