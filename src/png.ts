/**
 * A small PNG codec for the design check (Phase 30c): Chrome's screenshots
 * and the handoff's renders in (8-bit grey, RGB, palette, grey + alpha and
 * RGBA; 16-bit read by its high byte; no interlacing), the diff overlay out
 * (RGBA, the Paeth-free `none`/`sub` filters). node:zlib only.
 */
import { createInflate, deflateSync, inflateSync } from 'node:zlib'
export type RgbaImage = { width: number; height: number; data: Uint8Array }

/** A decoded picture this big is refused (about 120 MB of pixels). */
export const PNG_MAX_PIXELS = 30_000_000

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

type PngHead = {
  width: number; height: number; depth: number; type: number
  channels: number; palette: Uint8Array | null; trns: Uint8Array | null; idat: Uint8Array[]
}

/** The header, palette and data chunks of a PNG this codec reads, or why it doesn't. */
function readPng(bytes: Uint8Array): PngHead | { error: string } {
  if (bytes.length < 33 || !SIGNATURE.every((x, i) => bytes[i] === x)) return { error: 'not a PNG file' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at)
    const kind = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const data = bytes.subarray(at + 8, at + 8 + len)
    if (kind === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12)
      depth = bytes[at + 16]!; type = bytes[at + 17]!; interlace = bytes[at + 20]!
    } else if (kind === 'PLTE') palette = data
    else if (kind === 'tRNS') trns = data
    else if (kind === 'IDAT') idat.push(data)
    else if (kind === 'IEND') break
    at += 12 + len
  }
  if (!width || !height) return { error: 'the PNG has no header' }
  if (width * height > PNG_MAX_PIXELS) return { error: `the picture is ${width}x${height}; render it smaller (at most ${PNG_MAX_PIXELS / 1_000_000} million pixels)` }
  if (interlace) return { error: 'interlaced PNGs are not read; render it again with render-page' }
  const channels = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : type === 6 ? 4 : 0
  if (!channels || (depth !== 8 && depth !== 16) || (type === 3 && depth !== 8)) return { error: 'this PNG kind is not read; render it again with render-page' }
  return { width, height, depth, type, channels, palette, trns, idat }
}

/** Undo one scanline's filter in place (`cur` from the raw row, `prev` the row above, already undone). */
function unfilter(f: number, row: Uint8Array, cur: Uint8Array, prev: Uint8Array, bpp: number) {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0
    const x = row[i]!
    cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff
  }
}

/** One unfiltered scanline as RGBA into `out` at pixel offset `o0`. */
function toRgba(h: PngHead, cur: Uint8Array, out: Uint8Array | Uint32Array, o0: number) {
  const { width, depth, type, palette, trns } = h
  const step = depth / 8
  const bpp = h.channels * step
  for (let x = 0; x < width; x++) {
    const o = o0 + x * 4
    const s = x * bpp
    let r: number, g: number, b: number, al: number
    if (type === 6) { r = cur[s]!; g = cur[s + step]!; b = cur[s + 2 * step]!; al = cur[s + 3 * step]! }
    else if (type === 2) { r = cur[s]!; g = cur[s + step]!; b = cur[s + 2 * step]!; al = 255 }
    else if (type === 0) { r = g = b = cur[s]!; al = 255 }
    else if (type === 4) { r = g = b = cur[s]!; al = cur[s + step]! }
    else {
      const i = cur[s]!
      r = palette?.[i * 3] ?? 0; g = palette?.[i * 3 + 1] ?? 0; b = palette?.[i * 3 + 2] ?? 0; al = trns && i < trns.length ? trns[i]! : 255
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = al
  }
}

/** Decode a PNG to RGBA, or say why not. */
export function decodePng(bytes: Uint8Array): RgbaImage | { error: string } {
  const h = readPng(bytes)
  if ('error' in h) return h
  const { width, height } = h
  let raw: Uint8Array
  try { raw = inflateSync(Buffer.concat(h.idat)) } catch { return { error: 'the PNG data is damaged' } }
  const bpp = h.channels * (h.depth / 8)
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) return { error: 'the PNG data is cut short' }
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride)
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    unfilter(raw[y * (stride + 1)]!, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur, prev, bpp)
    toRgba(h, cur, out, y * width * 4)
    prev.set(cur)
  }
  return { width, height, data: out }
}

/**
 * Decode a PNG made smaller by the largest whole factor that keeps it at least `toWidth` wide (never enlarged),
 * each output pixel the average of its block; with `maxHeight` (counted at `toWidth`; a narrower picture keeps
 * `maxHeight` rows) it stops after that many rows. Streamed: the data is inflated in chunks and unfiltered a row at a time, so the memory it takes is the
 * picture it returns (a scale-2 screenshot comes back at a quarter of its pixels), and it yields between chunks
 * instead of holding the process for the whole picture. The design check and the critic read renders this way
 * (2026-10-17: decoding fourteen scale-2 shots whole took the 1 GB api past its memory).
 */
export async function decodePngScaled(bytes: Uint8Array, opts: { toWidth: number; maxHeight?: number }): Promise<RgbaImage | { error: string }> {
  const h = readPng(bytes)
  if ('error' in h) return h
  const k = Math.max(1, Math.floor(h.width / Math.max(1, opts.toWidth)))
  const width = Math.max(1, Math.floor(h.width / k))
  const fullRows = Math.max(1, Math.floor(h.height / k))
  // Rows counted at toWidth: a wider result keeps proportionally more (scaled down after), a narrower one keeps maxHeight.
  const cap = opts.maxHeight ? Math.max(1, Math.ceil(opts.maxHeight * Math.max(1, width / Math.max(1, opts.toWidth)))) : Infinity
  const height = Math.min(fullRows, cap)
  const bpp = h.channels * (h.depth / 8)
  const stride = h.width * bpp
  const rowsNeeded = height * k
  const out = new Uint8Array(width * height * 4)
  const line = new Uint8Array(stride + 1)
  let filled = 0
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride)
  const full = k === 1 ? null : new Uint32Array(h.width * 4)
  const sums = k === 1 ? null : new Uint32Array(width * 4)
  let y = 0
  const takeRow = () => {
    unfilter(line[0]!, line.subarray(1), cur, prev, bpp)
    prev.set(cur)
    const oy = Math.floor(y / k)
    if (!full || !sums) toRgba(h, cur, out, oy * width * 4)
    else {
      toRgba(h, cur, full, 0)
      for (let x = 0; x < width * k; x++) {
        const s = x * 4, d = Math.floor(x / k) * 4
        sums[d] = sums[d]! + full[s]!; sums[d + 1] = sums[d + 1]! + full[s + 1]!; sums[d + 2] = sums[d + 2]! + full[s + 2]!; sums[d + 3] = sums[d + 3]! + full[s + 3]!
      }
      if (y % k === k - 1) {
        const n = k * k
        for (let i = 0; i < sums.length; i++) out[oy * width * 4 + i] = Math.round(sums[i]! / n)
        sums.fill(0)
      }
    }
    y++
  }
  const inflate = createInflate()
  inflate.end(Buffer.concat(h.idat))
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      let at = 0
      while (at < chunk.length && y < rowsNeeded) {
        const n = Math.min(line.length - filled, chunk.length - at)
        line.set(chunk.subarray(at, at + n), filled)
        filled += n; at += n
        if (filled === line.length) { takeRow(); filled = 0 }
      }
      if (y >= rowsNeeded) break
    }
  } catch {
    return { error: 'the PNG data is damaged' }
  } finally {
    inflate.destroy()
  }
  if (y < rowsNeeded) return { error: 'the PNG data is cut short' }
  return { width, height, data: out }
}

function chunk(kind: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode RGBA as a PNG (each row filtered with `sub`, which suits flat screens). */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, data } = img
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1)
    raw[o] = 1
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (data[y * stride + i]! - (i >= 4 ? data[y * stride + i - 4]! : 0)) & 0xff
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width); v.setUint32(4, height)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
