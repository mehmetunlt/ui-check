import { deflateSync } from 'node:zlib'
import {
  IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, IMAGE_MIN_PIXELS, IMAGE_MIN_SIDE, IMAGE_REQUEST_MAX_BYTES,
  type DecideAsset, type Question,
} from './types.ts'

/*
 * Images for decisions (dlook, design quality spec §9a), pure. On OpenRouter's decisions
 * endpoint an image is an `image_url` part, { "type": "image_url", "image_url": { "url":
 * "data:image/png;base64,..." } }, in `state` or (Jev only) at any depth in `state` and in a
 * question's instructions and criteria; still PNG or JPEG within fixed limits, rejected (never
 * resized) outside them. (The classifier's own `assets` map and opt-in header are dropped
 * there: live probe 2026-10-18, the same input tokens with or without them.) Callers name each
 * image by a reference string; `withImages` puts the image part where the reference is. These
 * helpers also check an image the way the endpoint would, from its header alone.
 */

export type ImageInfo = { format: 'png' | 'jpg'; width: number; height: number; animated: boolean }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Format, size and (for PNG) whether it is animated, from the header; null when it is neither a PNG nor a JPEG. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (!b || b.length < 24) return null
  const u32 = (at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
  const u16 = (at: number) => (b[at]! << 8) | b[at + 1]!
  if (PNG_SIG.every((x, i) => b[i] === x)) {
    const width = u32(16), height = u32(20)
    // An animated PNG names its animation (acTL) before the first image data.
    let animated = false
    for (let at = 8; at + 8 <= b.length;) {
      const len = u32(at)
      const kind = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!)
      if (kind === 'acTL') { animated = true; break }
      if (kind === 'IDAT' || kind === 'IEND') break
      at += 12 + len
    }
    return { format: 'png', width, height, animated }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let at = 2
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) { at++; continue }
      const marker = b[at + 1]!
      if (marker === 0xd8 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) { at += marker === 0xff ? 1 : 2; continue }
      // Start of frame (any SOF but DHT, JPG and DAC): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { format: 'jpg', width: u16(at + 7), height: u16(at + 5), animated: false }
      at += 2 + u16(at + 2)
    }
  }
  return null
}

/** Why the endpoint would reject this image, in words for a log; null when it is within the limits. */
export function imageAssetProblem(asset: DecideAsset): string | null {
  if (!asset || (asset.format !== 'png' && asset.format !== 'jpg')) return 'the format must be png or jpg'
  if (!(asset.data instanceof Uint8Array)) return 'no image bytes'
  if (asset.data.length > IMAGE_MAX_BYTES) return 'the image is over 16 MiB'
  const info = imageInfo(asset.data)
  if (!info) return 'not a PNG or JPEG image'
  if (info.format !== asset.format) return `the bytes are ${info.format}, not ${asset.format}`
  if (info.animated) return 'an animated PNG is not a still image'
  if (info.width < IMAGE_MIN_SIDE || info.height < IMAGE_MIN_SIDE) return `${info.width} x ${info.height} px: each side must be at least ${IMAGE_MIN_SIDE} px`
  if (info.width > IMAGE_MAX_SIDE || info.height > IMAGE_MAX_SIDE) return `${info.width} x ${info.height} px: each side must be at most ${IMAGE_MAX_SIDE} px`
  const px = info.width * info.height
  if (px < IMAGE_MIN_PIXELS || px > IMAGE_MAX_PIXELS) return `${px} pixels is outside ${IMAGE_MIN_PIXELS} to ${IMAGE_MAX_PIXELS}`
  return null
}

const enc = new TextEncoder()

/**
 * An image reference is a long token of letters, digits, "-" and "_" (at least IMAGE_REF_MIN_CHARS,
 * e.g. `look-` and a UUID), and it is matched only as a whole token: never inside a longer token,
 * never as an object key. A short or common reference could otherwise corrupt the request.
 */
export const IMAGE_REF_MIN_CHARS = 16
const REF_CHARS = /^[A-Za-z0-9_-]+$/
const isRefChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_-]/.test(c)
/** Where `ref` stands as a whole token in `text` at or after `from`, or -1. */
export function findRef(text: string, ref: string, from = 0): number {
  for (let i = text.indexOf(ref, from); i >= 0; i = text.indexOf(ref, i + 1)) {
    if (!isRefChar(text[i - 1]) && !isRefChar(text[i + ref.length])) return i
  }
  return -1
}

/** Why this assets map can't be sent at all (a bad reference, a bad image, too many bytes); null when it can. */
export function assetsProblem(assets: Record<string, DecideAsset>): string | null {
  let total = 0, refBytes = 0
  for (const [ref, asset] of Object.entries(assets)) {
    const n = enc.encode(ref).length
    if (ref.length < IMAGE_REF_MIN_CHARS || !REF_CHARS.test(ref)) return `an image reference must be ${IMAGE_REF_MIN_CHARS} or more letters, digits, "-" or "_"`
    if (n > 1024) return 'an image reference over 1,024 bytes'
    refBytes += n
    const p = imageAssetProblem(asset)
    if (p) return `${ref.slice(0, 40)}: ${p}`
    total += asset.data.length
  }
  if (refBytes > 65_536) return 'the image references are over 65,536 bytes'
  if (total > IMAGE_REQUEST_MAX_BYTES) return 'the images are over 23 MiB together'
  return null
}

/** Every string value in a JSON-shaped value (object keys are not references). */
function strings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
}

/** The asset keys the request's strings name: the state's values, each question's instructions and criteria. */
export function referencedAssets(state: string | object, questions: Record<string, Question>, assets: Record<string, DecideAsset>): string[] {
  const texts: string[] = []
  strings(state, texts)
  for (const q of Object.values(questions)) { strings(q.instructions, texts); strings(q.criteria ?? null, texts) }
  return Object.keys(assets).filter((ref) => texts.some((t) => findRef(t, ref) >= 0))
}

export type ImagePart = { type: 'image_url'; image_url: { url: string } }

/** An image as the endpoint reads it: a base64 data URL of its own type. */
export const imagePart = (a: DecideAsset): ImagePart => ({ type: 'image_url', image_url: { url: `data:image/${a.format === 'png' ? 'png' : 'jpeg'};base64,${Buffer.from(a.data).toString('base64')}` } })

/**
 * The value with each reference replaced by its image part: a string that is exactly a
 * reference becomes the part; a longer string naming references becomes an array of the text
 * around them and the parts, in order (Jev reads image parts at any depth). Object keys are
 * never replaced. `used` collects the references that were placed.
 */
export function withImages(v: unknown, parts: ReadonlyMap<string, ImagePart>, used: Set<string>): unknown {
  if (typeof v === 'string') {
    if (!parts.size) return v
    const exact = parts.get(v)
    if (exact) { used.add(v); return exact }
    const refs = [...parts.keys()].filter((r) => findRef(v, r) >= 0)
    if (!refs.length) return v
    const out: unknown[] = []
    let rest = v
    while (rest) {
      let at = -1, ref = ''
      for (const r of refs) { const i = findRef(rest, r); if (i >= 0 && (at < 0 || i < at)) { at = i; ref = r } }
      if (at < 0) { out.push(rest); break }
      if (at > 0) out.push(rest.slice(0, at))
      out.push(parts.get(ref)!)
      used.add(ref)
      rest = rest.slice(at + ref.length)
    }
    return out
  }
  if (Array.isArray(v)) return v.map((x) => withImages(x, parts, used))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withImages(x, parts, used)]))
  return v
}

/** Models that read images: Jev 1.13 and 1.14 (Luna and the rest are text only). */
export const acceptsImages = (model: string): boolean => /^typesafe\/jev-/.test(model)

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

/** A plain square of one colour as a PNG (the client's image check). */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const row = new Uint8Array(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = new Uint8Array(row.length * height)
  for (let y = 0; y < height; y++) raw.set(row, y * row.length)
  const chunk = (kind: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const v = new DataView(out.buffer)
    v.setUint32(0, data.length)
    out.set(enc.encode(kind), 4)
    out.set(data, 8)
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width); v.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 2
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { all.set(p, at); at += p.length }
  return all
}

/** The raw image bytes a request would carry, every use of a reference counted (each use is a copy). */
export function imageUses(state: string | object, questions: Record<string, Question>, assets: Record<string, DecideAsset>): number {
  const texts: string[] = []
  strings(state, texts)
  for (const q of Object.values(questions)) { strings(q.instructions, texts); strings(q.criteria ?? null, texts) }
  let total = 0
  for (const [ref, a] of Object.entries(assets)) for (const t of texts) for (let i = findRef(t, ref); i >= 0; i = findRef(t, ref, i + ref.length)) total += a.data.length
  return total
}
