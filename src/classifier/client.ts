import { modelAuthorization, reportModelCall } from '../models/index.ts'
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURES,
  DECISION_TIMEOUT_MS,
  DECISIONS_ENDPOINT,
  DEFAULT_DECISION_MODELS,
  IMAGE_BODY_MAX_BYTES,
  IMAGE_CHECK_RETRY_MS,
  IMAGE_CHECK_TIMEOUT_MS,
  IMAGE_CHECK_TTL_MS,
  IMAGE_DECISION_TIMEOUT_MS,
  IMAGE_REQUEST_MAX_BYTES,
  MAX_QUESTIONS_PER_CALL,
  MAX_STATE_CHARS,
  type Answer,
  type DecideAsset,
  type DecideRequest,
  type DecisionResult,
  type Decisions,
  type Question,
} from './types.ts'
import { acceptsImages, assetsProblem, imagePart, imageUses, solidPng, withImages, type ImagePart } from './images.ts'

/*
 * Client for OpenRouter's decisions endpoint (ported from Modus
 * apps/api/src/services/jev/jev-client.ts, reshaped for per-step computer use):
 *
 * - models are tried in order (Jev, then Luna) with a 2 s timeout each and no
 *   retry on the same model; there is no chat stand-in, so when every model
 *   fails the answers are all null and the caller uses code signals only;
 * - at most 8 questions per call, more are split into parallel calls and merged;
 * - a breaker skips a model for 60 s after 3 consecutive failures;
 * - images (dlook): a request with `assets` goes only to the image models (Jev), each image
 *   checked against the endpoint's limits first (one outside them: no call, unavailable) and
 *   sent as an `image_url` part (a base64 data URL) where its reference stands in `state`, the
 *   instructions or the criteria, each split call carrying only the images it names, with the
 *   longer image timeout and a breaker of its own (`<model>#images`), so image failures never
 *   switch a model off for text; a rejected image (400, 413) is the request's fault, so it
 *   counts toward no breaker and tries no other model. An image no string names after the
 *   state is capped (cut off, or a misspelt reference) makes the request unavailable, never a
 *   text-only answer about a picture nobody sent. A text request is sent exactly as before;
 * - a route can drop images and answer from the words alone (live probe 2026-10-18: the
 *   classifier's own `assets` map was ignored there, the same input tokens with or without it),
 *   so before the first image answer is trusted, and every 30 minutes, an image check shows two
 *   plain squares, one red and one blue in a random order under fresh names that say nothing,
 *   and asks "red?" and "blue?" of each; unless all four answers are right by a clear margin
 *   (at least 0.8 and at most 0.2), image requests answer unavailable without a call;
 * - every answered call reports one ModelCall into the ambient cost sink.
 */

export type CreateDecisionsOptions = {
  apiKey: string
  fetch?: typeof globalThis.fetch
  /** Tried in order. Default [jev-1.14, gpt-6-luna-decisions]. */
  models?: readonly string[]
  /** Per model, per call. Default 2,000 ms. */
  timeoutMs?: number
  /** Per model, per call, when the call carries images. Default IMAGE_DECISION_TIMEOUT_MS (12 s), never shorter than timeoutMs. */
  imageTimeoutMs?: number
  /** The image check before image answers are trusted. Default true; tests that script image answers turn it off. */
  imageCheck?: boolean
  /** Randomness for the image check (which slot is red, the names). Default Math.random. */
  random?: () => number
  /** Clock for the breaker and latency. Default Date.now. */
  now?: () => number
}

type RawAnswer = { type?: unknown; noul?: unknown; choice?: unknown; score?: unknown; probabilities?: unknown; confidence?: unknown }
type WireBody = {
  model?: unknown
  answers?: Record<string, RawAnswer>
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown }
}

type Breaker = { failures: number; openUntil: number }

/** A chunk's outcome: which model answered and its raw answers, or null when no model did. */
type ChunkOutcome = { model: string; modelId: string | null; raw: Record<string, RawAnswer> } | null

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function createDecisions(opts: CreateDecisionsOptions): Decisions {
  const doFetch = opts.fetch ?? globalThis.fetch
  const models = opts.models?.length ? [...opts.models] : [...DEFAULT_DECISION_MODELS]
  const timeoutMs = opts.timeoutMs ?? DECISION_TIMEOUT_MS
  const imageTimeoutMs = Math.max(timeoutMs, opts.imageTimeoutMs ?? IMAGE_DECISION_TIMEOUT_MS)
  const now = opts.now ?? Date.now
  const breakers = new Map<string, Breaker>(models.map((m) => [m, { failures: 0, openUntil: 0 }]))

  const fail = (model: string) => {
    const b = breakers.get(model)!
    b.failures += 1
    // Still >= the threshold after a half-open probe fails, so it reopens at once.
    if (b.failures >= BREAKER_FAILURES) b.openUntil = now() + BREAKER_COOLDOWN_MS
  }
  const succeed = (model: string) => {
    const b = breakers.get(model)!
    b.failures = 0
    b.openUntil = 0
  }

  /**
   * One POST to one model. Resolves to the raw answers, 'rejected' when the endpoint refused
   * the request's images (400 or 413 on a call with images), or null on any other failure. Never throws.
   */
  async function callModel(model: string, payload: string, outer?: AbortSignal, images = false, deadlineMs?: number): Promise<{ raw: Record<string, RawAnswer>; modelId: string | null } | 'rejected' | null> {
    const ms = deadlineMs ?? (images ? imageTimeoutMs : timeoutMs)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error(`decisions timeout after ${ms} ms`)), ms)
    const signal = outer ? AbortSignal.any([outer, ctrl.signal]) : ctrl.signal
    try {
      const res = await doFetch(DECISIONS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: modelAuthorization(opts.apiKey), 'Content-Type': 'application/json' },
        body: payload,
        signal,
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return images && (res.status === 400 || res.status === 413) ? 'rejected' : null
      }
      const body = (await res.json()) as WireBody
      if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') return null
      const cost = body.usage?.cost
      reportModelCall({
        // The requested id: the endpoint answers with a dated one (typesafe/jev-1.14-20261014)
        // that the catalog does not know, and there is no failover inside one request.
        model,
        inputTokens: num(body.usage?.input_tokens),
        outputTokens: num(body.usage?.output_tokens),
        cachedInputTokens: 0,
        reasoningTokens: 0,
        actualCostMicroUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) : null,
        finishReason: null,
      })
      // The endpoint's own (dated) id, kept next to the requested one for the action log (P5b-R2).
      return { raw: body.answers, modelId: typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 120) : null }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function callChunk(state: string | object, questions: Record<string, Question>, outer?: AbortSignal, images?: Record<string, DecideAsset>, deadlineMs?: number): Promise<ChunkOutcome> {
    // Each image goes where its reference stands; one this chunk's strings never name is not sent.
    const parts = images ? new Map<string, ImagePart>(Object.entries(images).map(([ref, a]) => [ref, imagePart(a)])) : null
    const used = new Set<string>()
    const wireState = parts ? withImages(state, parts, used) : state
    const wireQuestions = parts ? withImages(questions, parts, used) : questions
    const withImg = used.size > 0
    for (const model of models) {
      if (outer?.aborted) return null
      if (withImg && !acceptsImages(model)) continue
      // Image calls keep their own breaker: an early feature's failures never switch a model off for text.
      const key = withImg ? `${model}#images` : model
      if (!breakers.has(key)) breakers.set(key, { failures: 0, openUntil: 0 })
      if (now() < breakers.get(key)!.openUntil) continue
      const body = JSON.stringify({ model, state: wireState, questions: wireQuestions })
      // Every use of an image is a copy in the body: past the endpoint's limit it would be refused.
      if (withImg && body.length > IMAGE_BODY_MAX_BYTES) return null
      const got = await callModel(model, body, outer, withImg, deadlineMs)
      // A caller's abort is not the model's failure: no breaker count, no fallback.
      if (outer?.aborted) return null
      // The images were refused: the next model would refuse them too, and the model is not at fault.
      if (got === 'rejected') return null
      if (got) {
        succeed(key)
        return { model, modelId: got.modelId, raw: got.raw }
      }
      fail(key)
    }
    return null
  }

  /*
   * The image check: a red and a blue square in a random order, under fresh names that say
   * nothing, and "red?" and "blue?" asked of each. A route that sees images gets all four right;
   * one that drops them, or leans on the order of the questions, can't. Kept for
   * IMAGE_CHECK_TTL_MS when it passes or fails, IMAGE_CHECK_RETRY_MS when nothing answered.
   */
  let check: { ok: boolean; until: number } | null = null
  let checking: Promise<boolean> | null = null
  const RED = solidPng(280, 280, [220, 30, 30])
  const BLUE = solidPng(280, 280, [30, 60, 220])
  const random = opts.random ?? Math.random
  const opaque = () => `img-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`
  /** dpolish: a fresh name for a slot too, so a route biased by a slot's name alone (always "the first is red") learns nothing. */
  const slotName = () => `pic_${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`
  /** A first borderline answer is a soft failure: images stay off for IMAGE_CHECK_RETRY_MS, and only a second one in a row (or a clear failure) holds for IMAGE_CHECK_TTL_MS. */
  let softFails = 0
  async function imagesSeen(): Promise<boolean> {
    if (opts.imageCheck === false) return true
    if (check && now() < check.until) return check.ok
    checking ??= (async () => {
      const redFirst = random() < 0.5
      // Two names that differ even when a test's random source is constant.
      const pair = (make: () => string): [string, string] => { const a = make(); const b = make(); return [a, b === a ? `${b}x` : b] }
      const [one, two] = pair(opaque)
      const [slotOne, slotTwo] = pair(slotName)
      const colour = { [one]: redFirst ? 'red' : 'blue', [two]: redFirst ? 'blue' : 'red' }
      const q = (slot: string, c: string): Question => ({ type: 'noul', instructions: `Is the picture in \`${slot}\` a plain square of solid ${c}?` })
      const questions = { [`${slotOne}_red`]: q(slotOne, 'red'), [`${slotOne}_blue`]: q(slotOne, 'blue'), [`${slotTwo}_red`]: q(slotTwo, 'red'), [`${slotTwo}_blue`]: q(slotTwo, 'blue') }
      const got = await callChunk({ [slotOne]: one, [slotTwo]: two }, questions, undefined,
        { [one]: { format: 'png', data: colour[one] === 'red' ? RED : BLUE }, [two]: { format: 'png', data: colour[two] === 'red' ? RED : BLUE } }, IMAGE_CHECK_TIMEOUT_MS)
      const p = (id: string) => { const a = normalizeRawAnswer(got?.raw[id], { type: 'noul', instructions: '' }); return a && a.type === 'noul' ? a.noul : null }
      // Per picture: right (both answers clear and correct), wrong (a clear wrong answer), or borderline (unclear or missing).
      const verdict = (slot: string, ref: string): 'right' | 'wrong' | 'borderline' => {
        const isRed = colour[ref] === 'red'
        const r = p(`${slot}_red`), b = p(`${slot}_blue`)
        if (r === null || b === null) return 'borderline'
        const [yes, no] = isRed ? [r, b] : [b, r]
        if (yes >= 0.8 && no <= 0.2) return 'right'
        // Wrong, or no telling red from blue at all (a route that dropped the pictures answers both alike).
        if (yes <= 0.2 || no >= 0.8 || yes - no <= 0.1) return 'wrong'
        return 'borderline'
      }
      const v = [verdict(slotOne, one), verdict(slotTwo, two)]
      const ok = v.every((x) => x === 'right')
      const clear = v.includes('wrong')
      const soft = !ok && !clear && !!got
      softFails = ok ? 0 : soft ? softFails + 1 : 0
      const holds = ok || !got ? (got ? IMAGE_CHECK_TTL_MS : IMAGE_CHECK_RETRY_MS) : soft && softFails < 2 ? IMAGE_CHECK_RETRY_MS : IMAGE_CHECK_TTL_MS
      check = { ok, until: now() + holds }
      return ok
    })().finally(() => { checking = null })
    return checking
  }

  return {
    async decide(req: DecideRequest): Promise<DecisionResult> {
      const startedAt = now()
      const ids = Object.keys(req.questions ?? {})
      const answers: Record<string, Answer | null> = Object.fromEntries(ids.map((id) => [id, null]))
      try {
        if (ids.length === 0) return { answers, model: null, source: 'unavailable', latencyMs: 0 }
        const images = req.assets && Object.keys(req.assets).length ? req.assets : undefined
        // An image the endpoint would reject is never sent (it rejects, never resizes): the caller's code signal stands.
        if (images && assetsProblem(images)) return { answers, model: null, source: 'unavailable', latencyMs: 0 }
        // A route that drops images would answer from the words alone: unavailable until the image check passes.
        if (images && !(await imagesSeen())) return { answers, model: null, source: 'unavailable', latencyMs: Math.max(0, now() - startedAt) }
        const state = capState(req.state)
        // Every image must still be named after the cap (a reference cut off, or misspelt, would leave a text-only
        // answer about a picture nobody sent): otherwise unavailable, with no call.
        if (images) {
          const named = new Set<string>()
          const marks = new Map(Object.keys(images).map((ref) => [ref, { type: 'image_url' as const, image_url: { url: '' } }]))
          withImages(state, marks, named)
          withImages(req.questions, marks, named)
          if (named.size < marks.size) return { answers, model: null, source: 'unavailable', latencyMs: Math.max(0, now() - startedAt) }
          // Each use is a copy: the raw bytes of every use together stay under the request limit.
          if (imageUses(state, req.questions, images) > IMAGE_REQUEST_MAX_BYTES) return { answers, model: null, source: 'unavailable', latencyMs: 0 }
        }
        const chunks: Array<Record<string, Question>> = []
        for (let i = 0; i < ids.length; i += MAX_QUESTIONS_PER_CALL) {
          chunks.push(Object.fromEntries(ids.slice(i, i + MAX_QUESTIONS_PER_CALL).map((id) => [id, req.questions[id]!])))
        }
        const outcomes = await Promise.all(chunks.map((qs) => callChunk(state, qs, req.signal, images)))
        const answeredBy: string[] = []
        const dated: string[] = []
        outcomes.forEach((o, i) => {
          if (!o) return
          if (!answeredBy.includes(o.model)) answeredBy.push(o.model)
          if (o.modelId && !dated.includes(o.modelId)) dated.push(o.modelId)
          for (const [id, q] of Object.entries(chunks[i]!)) answers[id] = normalizeRawAnswer(o.raw[id], q)
        })
        const latencyMs = Math.max(0, now() - startedAt)
        if (answeredBy.length === 0) return { answers, model: null, source: 'unavailable', latencyMs }
        return { answers, model: answeredBy.join(','), ...(dated.length ? { modelId: dated.join(',') } : {}), source: 'calibrated', latencyMs }
      } catch {
        return { answers, model: null, source: 'unavailable', latencyMs: Math.max(0, now() - startedAt) }
      }
    },
  }
}

/** A string over the cap is cut; an object whose JSON is over the cap is sent as its cut JSON string. */
export function capState(state: string | object): string | object {
  if (typeof state === 'string') return state.length > MAX_STATE_CHARS ? state.slice(0, MAX_STATE_CHARS) : state
  const json = JSON.stringify(state) ?? ''
  return json.length > MAX_STATE_CHARS ? json.slice(0, MAX_STATE_CHARS) : state
}

/**
 * Raw endpoint answer -> typed Answer, or null (Modus normalizeRawAnswer).
 *
 * Kept from Modus: an unreadable value is a MISSING answer, not a confident
 * one (NaN would clamp to 0, and a noul of 0 reads as "no, with certainty").
 * Added here: a question id missing from the reply is null; an answer of a
 * different type than asked is null; a choice that is not one of the offered
 * ids is null (a caller would otherwise act on an element nobody offered).
 */
export function normalizeRawAnswer(raw: unknown, question: Question): Answer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawAnswer
  if (r.type !== question.type) return null
  if (question.type === 'noul') {
    const n = readNumber(r.noul)
    if (n === null) return null
    const noul = clamp01(n)
    return { type: 'noul', noul, confidence: clamp01(Math.abs(noul - 0.5) * 2) }
  }
  if (question.type === 'choice') {
    if (typeof r.choice !== 'string' || !Object.hasOwn(question.criteria, r.choice)) return null
    const probabilities = normalizeProbs(r.probabilities)
    return { type: 'choice', choice: r.choice, probabilities, confidence: confidenceOf(r.confidence, probabilities) }
  }
  const score = readNumber(r.score)
  if (score === null) return null
  const probabilities = normalizeProbs(r.probabilities)
  return { type: 'score', score, probabilities, confidence: confidenceOf(r.confidence, probabilities) }
}

/** A finite number, or a numeric string (Modus used Number()); null, '', booleans and junk are unreadable. */
function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function confidenceOf(reported: unknown, probs: Record<string, number>): number {
  if (typeof reported === 'number' && Number.isFinite(reported)) return clamp01(reported)
  const vals = Object.values(probs)
  return vals.length ? clamp01(Math.max(...vals)) : 0
}

function normalizeProbs(probs: unknown): Record<string, number> {
  if (!probs || typeof probs !== 'object') return {}
  const entries = Object.entries(probs as Record<string, unknown>).map(([k, v]) => [k, Math.max(0, num(v))] as const)
  const sum = entries.reduce((s, [, v]) => s + v, 0)
  if (sum <= 0) return Object.fromEntries(entries)
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum]))
}
