import OpusScript from 'opusscript'

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, starting from zero. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t[i] = r >>> 0
  }
  return t
})()

export function oggCrc(buf: Uint8Array): number {
  let c = 0
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0
  return c
}

/** One Ogg page holding whole packets. */
function page(packets: Buffer[], granule: bigint, serial: number, seq: number, flags: number): Buffer {
  const lacing: number[] = []
  for (const p of packets) {
    let n = p.length
    while (n >= 255) {
      lacing.push(255)
      n -= 255
    }
    lacing.push(n)
  }
  const head = Buffer.alloc(27 + lacing.length)
  head.write('OggS', 0, 'ascii')
  head[4] = 0
  head[5] = flags
  head.writeBigInt64LE(granule, 6)
  head.writeUInt32LE(serial, 14)
  head.writeUInt32LE(seq, 18)
  head[26] = lacing.length
  lacing.forEach((v, i) => (head[27 + i] = v))
  const out = Buffer.concat([head, ...packets])
  out.writeUInt32LE(oggCrc(out), 22)
  return out
}

const RATES = [8000, 12000, 16000, 24000, 48000]

/**
 * Mono 16-bit PCM as an Ogg Opus file: what Telegram plays as a voice note. 20 ms frames, encoded
 * with libopus (compiled to WebAssembly, so nothing native to install).
 */
export function encodeOggOpus(pcm: Buffer, rate: number): Buffer {
  if (!RATES.includes(rate)) throw new Error(`Opus cannot take ${rate} Hz audio.`)
  const frame = rate / 50
  const encoder = new OpusScript(rate as 24000, 1, OpusScript.Application.VOIP)
  try {
    const bytes = frame * 2
    const padded = pcm.length % bytes ? Buffer.concat([pcm, Buffer.alloc(bytes - (pcm.length % bytes))]) : pcm
    const packets: Buffer[] = []
    for (let off = 0; off < padded.length; off += bytes) packets.push(Buffer.from(encoder.encode(padded.subarray(off, off + bytes), frame)))
    const serial = (Math.random() * 0xffffffff) >>> 0
    const preSkip = 312
    const opusHead = Buffer.alloc(19)
    opusHead.write('OpusHead', 0, 'ascii')
    opusHead[8] = 1
    opusHead[9] = 1
    opusHead.writeUInt16LE(preSkip, 10)
    opusHead.writeUInt32LE(rate, 12)
    opusHead.writeInt16LE(0, 16)
    opusHead[18] = 0
    const vendor = Buffer.from('multimine', 'ascii')
    const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4)
    opusTags.write('OpusTags', 0, 'ascii')
    opusTags.writeUInt32LE(vendor.length, 8)
    vendor.copy(opusTags, 12)
    opusTags.writeUInt32LE(0, 12 + vendor.length)
    const pages = [page([opusHead], 0n, serial, 0, 0x02), page([opusTags], 0n, serial, 1, 0)]
    // granule positions count 48 kHz samples, whatever the input rate
    const per48 = 960
    let seq = 2
    for (let i = 0; i < packets.length; i += 50) {
      const chunk = packets.slice(i, i + 50)
      const done = i + chunk.length
      pages.push(page(chunk, BigInt(preSkip + done * per48), serial, seq++, done === packets.length ? 0x04 : 0))
    }
    return Buffer.concat(pages)
  } finally {
    encoder.delete()
  }
}
