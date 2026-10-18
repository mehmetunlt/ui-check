/*
 * Typed decisions ("System One" classifiers) and click grounding.
 *
 * Question and answer shapes follow the decisions endpoint's schema, as the
 * Modus client (apps/api/src/services/jev/jev-client.ts) declares them. A
 * decision is a typed judgment with a calibrated probability, never prose.
 */

/** OpenRouter's typed-decision endpoint (same schema for every decisions model). */
export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
/** OpenRouter chat completions, used for grounding. */
export const CHAT_COMPLETIONS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

export const JEV_MODEL = 'typesafe/jev-1.14'
export const LUNA_MODEL = 'openai/gpt-6-luna-decisions'
export const UI_TARS_MODEL = 'bytedance/ui-tars-1.5-7b'
/** The Claude grounding fallbacks, in order (P5b-R1): cheap first. */
export const CLAUDE_GROUNDING_MODELS: readonly string[] = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5']

/** Primary first. A model is skipped while its breaker is open. */
export const DEFAULT_DECISION_MODELS: readonly string[] = [JEV_MODEL, LUNA_MODEL]
/** Per model, per call. No retry on the same model. */
export const DECISION_TIMEOUT_MS = 2_000
/** More questions than this are split into parallel calls. */
export const MAX_QUESTIONS_PER_CALL = 8
/** `state` is cut to this many characters. */
export const MAX_STATE_CHARS = 24_000
/** Consecutive failures that open a model's breaker... */
export const BREAKER_FAILURES = 3
/** ...and how long it then stays skipped. */
export const BREAKER_COOLDOWN_MS = 60_000
export const GROUNDING_TIMEOUT_MS = 5_000

// ---- Images (dlook; OpenRouter's multimodal decisions page, read 2026-10-18) -------
// An image is an `image_url` part with a base64 data URL (PNG or JPEG for Jev), placed in
// `state`, or in a question's instructions or criteria (Jev reads parts at any depth). Images
// are an early feature of the classifier: callers treat image answers as advisory. Out-of-range
// images are rejected (400 under the minimum, 413 over), never resized, so the client checks
// them first and sends nothing it would reject.

/** Each side, inclusive (Jev on OpenRouter). */
export const IMAGE_MIN_SIDE = 256
export const IMAGE_MAX_SIDE = 1568
/** Total pixels, inclusive, as well as the sides (so a 256 px side needs the other at 307 or more). */
export const IMAGE_MIN_PIXELS = 78_400
export const IMAGE_MAX_PIXELS = 2_458_624
/** Per image (decoded bytes). */
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024
/** Raw image bytes per request, every use counted: base64 grows them by a third, and the body must stay under 32 MiB. */
export const IMAGE_REQUEST_MAX_BYTES = 23 * 1024 * 1024
/** The whole JSON body of one image call, at most (the endpoint's limit is 32 MiB). */
export const IMAGE_BODY_MAX_BYTES = 31 * 1024 * 1024
/** Per model, per call, for a call that carries images (image calls are slower than text). */
export const IMAGE_DECISION_TIMEOUT_MS = 12_000

/** How long the image check's pass or fail holds, and how soon it is asked again when nothing answered. */
export const IMAGE_CHECK_TTL_MS = 30 * 60_000
export const IMAGE_CHECK_RETRY_MS = 60_000
/** The image check's own deadline: under a caller's usual 10 s, so its cost lands in the caller's sink. */
export const IMAGE_CHECK_TIMEOUT_MS = 8_000

/** One image for a decision: still PNG or JPEG bytes. */
export type DecideAsset = { format: 'png' | 'jpg'; data: Uint8Array }

// ---- Questions (what a caller asks) ---------------------------------------

export type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}
export type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  /** option id -> description, or null when the id describes itself */
  criteria: Record<string, string | null>
}
export type ScoreQuestion = {
  type: 'score'
  instructions: string
  /** ordered level descriptions, lowest first (2+ levels) */
  criteria: string[]
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

// ---- Answers (what a caller reads back) -----------------------------------

/** `noul` is P(true). The endpoint sends no confidence; it is the distance from 0.5, scaled to 0..1. */
export type NoulAnswer = { type: 'noul'; noul: number; confidence: number }
export type ChoiceAnswer = {
  type: 'choice'
  /** always one of the offered option ids */
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
/** `score` is the EXPECTED level index (a float over 0..levels-1), not a probability. */
export type ScoreAnswer = {
  type: 'score'
  score: number
  probabilities: Record<string, number>
  confidence: number
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/**
 * - `calibrated`: the decisions endpoint answered (either model).
 * - `simulated`: a scripted fake answered; this label goes into the action log.
 * - `unavailable`: nothing answered; every answer is null and callers use code signals only.
 */
export type DecisionSource = 'calibrated' | 'simulated' | 'unavailable'

export type DecisionResult = {
  /** One entry per asked question id; null means "no usable answer". */
  answers: Record<string, Answer | null>
  /** The model that answered (the requested id, not the dated one). Distinct models are joined by ',' when split calls were answered by different ones. */
  model: string | null
  /** The endpoint's own (dated) model id, e.g. typesafe/jev-1.14-20261014, when it said (P5b-R2); ',' joins several. */
  modelId?: string
  source: DecisionSource
  latencyMs: number
}

export type DecideRequest = {
  /** What is judged: a string, or any JSON-serializable object. */
  state: string | object
  questions: Record<string, Question>
  /** Why this call is made (e.g. 'page_state'); scripted fakes answer by it, logs group by it. */
  purpose: string
  signal?: AbortSignal
  /**
   * Images, keyed by a reference string that also appears in `state` or a question's
   * instructions or criteria: the client puts the image where its reference is (each use
   * adds a copy of the image) and sends nothing for a reference no string names. Optional: a
   * request without it is a text call, sent exactly as before. Only image models are asked; an
   * image outside the limits (IMAGE_*) is never sent and the call is `unavailable`.
   */
  assets?: Record<string, DecideAsset>
}

export interface Decisions {
  /** Never throws: a failure is `source: 'unavailable'` with every answer null. */
  decide(req: DecideRequest): Promise<DecisionResult>
}

// ---- Grounding --------------------------------------------------------------

export type LocateRequest = {
  /** The screenshot. Grounding reads a lossless PNG (ruling P5b-R1: UI-TARS mis-clicked on JPEG q60). */
  image: Uint8Array
  /** Default 'image/png'. */
  mime?: 'image/png' | 'image/jpeg'
  /** Screen size in pixels; a point outside it is null. */
  width: number
  height: number
  /** What to find, e.g. 'the "Sign in" button'. */
  target: string
  signal?: AbortSignal
}

export type Point = { x: number; y: number }

export interface Grounder {
  /** Absolute pixel coordinates of the target, or null (not found, unreadable, out of bounds, timeout, error). Never throws. */
  locate(req: LocateRequest): Promise<Point | null>
}
