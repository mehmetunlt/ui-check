import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestCandidate, isSelector, lookFails, lookProblems, parseSteps, planWords, resolveUrl, seeVerdict, stepLabel, tokenize } from './steps.ts'

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
