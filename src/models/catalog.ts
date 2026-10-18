/**
 * Price + context table, USD per million tokens. One row per OpenRouter wire id.
 * Used only when a call has no provider-reported actual cost (priceMicroUsd).
 * Because 1 USD/MTok == 1 micro-USD/token, tokens × rate is already micro-USD.
 */
export type CatalogRow = { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok: number; contextTokens: number }

export const MODEL_CATALOG: Record<string, CatalogRow> = {
  'anthropic/claude-sonnet-5.5': { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2, contextTokens: 1_000_000 },
  'anthropic/claude-opus-5.5': { inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.2, contextTokens: 1_000_000 },
  // The cheap Claude: the grounding fallback after UI-TARS (P5b-R1). Price as the Modus catalog lists it.
  'anthropic/claude-haiku-4.5': { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1, contextTokens: 200_000 },
  // Summary models (Ruling P6b-R1); prices and context from /api/v1/models on 2026-10-15.
  'anthropic/claude-haiku-5.5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01, contextTokens: 1_000_000 },
  'openai/gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01, contextTokens: 1_050_000 },
  // pcode: the cross-vendor reviewers and the coding engine's models; prices and context from /api/v1/models on 2026-10-16
  // (cache-read rates assumed at a tenth of input where the listing gives none).
  'openai/gpt-6-astra': { inputPerMTok: 10, outputPerMTok: 50, cachedInputPerMTok: 1, contextTokens: 1_050_000 },
  'openai/gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2, contextTokens: 1_050_000 },
  'google/gemini-4-argon': { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2, contextTokens: 1_048_576 },
  // UNVERIFIED: prices not confirmed against production; check before relying on the catalog fallback.
  'google/gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03, contextTokens: 1_048_576 },
  // Decisions models (OpenRouter /api/alpha/decisions): output is free, there is no cache tier.
  // Neither is listed in /api/v1/models, so contextTokens is a floor that covers the 24,000-char state cap.
  'typesafe/jev-1.14': { inputPerMTok: 0.042, outputPerMTok: 0, cachedInputPerMTok: 0.042, contextTokens: 32_000 },
  'openai/gpt-6-luna-decisions': { inputPerMTok: 0.1, outputPerMTok: 0, cachedInputPerMTok: 0.1, contextTokens: 32_000 },
  // Grounding VLM (chat completions); prices and context from /api/v1/models on 2026-10-15.
  'bytedance/ui-tars-1.5-7b': { inputPerMTok: 0.1, outputPerMTok: 0.2, cachedInputPerMTok: 0.1, contextTokens: 128_000 },
}

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5'
/** The cheap model summaries run on: compaction's first attempt (Ruling P6b-R1, current generation). */
export const DEFAULT_SUMMARY_MODEL = 'anthropic/claude-haiku-5.5'
/** Tried by OpenRouter, in order, when DEFAULT_SUMMARY_MODEL is unavailable (ModelRef.fallbacks). */
export const DEFAULT_SUMMARY_FALLBACKS: readonly string[] = ['openai/gpt-6-luna']

/**
 * The model's input window in tokens, from the catalog; null for a model the
 * catalog does not list. OpenRouter's ChatOpenAI reports `profile = {}`, so
 * this is where an agent's real window comes from first (research 03 §7.1).
 */
export function contextWindow(modelId: string): number | null {
  const n = MODEL_CATALOG[modelId]?.contextTokens
  return typeof n === 'number' && n > 0 ? n : null
}
