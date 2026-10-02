import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { random } from './text.mjs'

/**
 * Recordings of two people talking in turn: syllables with a moving pitch and two formants, pauses between
 * phrases and a quiet room under it all, so that a waveform has the shape of speech and an encoder spends its
 * bits as it would on speech. Ten minutes are synthesized and repeated, which costs the viewers the same as ten
 * minutes that never repeat. MP3 is encoded by lame and AAC by macOS's afconvert, the encoders of the files
 * people have; a machine without them cannot write those two files and says so.
 */

/** The minutes synthesized; a longer file repeats them. */
const BLOCK_SECONDS = 600
/** One period of the voice, as a table of samples, rebuilt for each syllable from its formants. */
const TABLE = 2048
const SINE = Float32Array.from({ length: TABLE }, (_, i) => Math.sin((2 * Math.PI * i) / TABLE))

/** Ten minutes of 16-bit PCM, interleaved when `channels` is 2. */
function speechBlock(sampleRate, channels, seed) {
  const next = random(seed)
  const frames = BLOCK_SECONDS * sampleRate
  const out = new Int16Array(frames * channels)
  const table = new Float32Array(TABLE)
  const speakers = [
    { pitch: 120, pan: [1, 0.72] },
    { pitch: 205, pan: [0.72, 1] }
  ]
  let frame = 0
  let speaker = 0
  let phase = 0
  while (frame < frames) {
    // A phrase of a few seconds, then a pause.
    const phraseEnd = Math.min(frames, frame + Math.floor((1.5 + next() * 6) * sampleRate))
    const { pitch, pan } = speakers[speaker]
    const gains = channels === 2 ? pan : [1]
    while (frame < phraseEnd) {
      const length = Math.floor((0.12 + next() * 0.16) * sampleRate)
      const voiced = next() < 0.82
      const loudness = 0.35 + next() * 0.55
      const f0Start = pitch * (0.85 + next() * 0.3)
      const f0End = f0Start * (0.9 + next() * 0.2)
      if (voiced) {
        const f1 = 300 + next() * 550
        const f2 = 900 + next() * 1400
        table.fill(0)
        for (let k = 1; k * f0Start < 4000; k++) {
          const f = k * f0Start
          const amplitude = Math.exp(-(((f - f1) / 160) ** 2)) + 0.6 * Math.exp(-(((f - f2) / 260) ** 2)) + 0.25 / k
          for (let i = 0; i < TABLE; i++) table[i] += amplitude * SINE[(k * i) % TABLE]
        }
        let peak = 0
        for (let i = 0; i < TABLE; i++) peak = Math.max(peak, Math.abs(table[i]))
        for (let i = 0; i < TABLE; i++) table[i] /= peak
      }
      for (let i = 0; i < length && frame < phraseEnd; i++, frame++) {
        const envelope = Math.sin((Math.PI * i) / length) ** 2 * loudness
        let value
        if (voiced) {
          phase = (phase + ((f0Start + ((f0End - f0Start) * i) / length) * TABLE) / sampleRate) % TABLE
          value = table[Math.floor(phase)] * envelope
        } else {
          value = (next() * 2 - 1) * envelope * 0.18
        }
        for (let c = 0; c < channels; c++) out[frame * channels + c] = Math.round((value * gains[c] * 0.55 + (next() * 2 - 1) * 0.002) * 32767)
      }
    }
    const pauseEnd = Math.min(frames, frame + Math.floor((0.25 + next() * 1.1) * sampleRate))
    for (; frame < pauseEnd; frame++) {
      for (let c = 0; c < channels; c++) out[frame * channels + c] = Math.round((next() * 2 - 1) * 0.002 * 32767)
    }
    if (next() < 0.6) speaker = 1 - speaker
  }
  return out
}

/** Writes a 16-bit PCM WAV of `seconds`, a whole number of ten-minute blocks. */
export function writeWav(file, { seconds, sampleRate, channels }) {
  if (seconds % BLOCK_SECONDS !== 0) throw new Error(`WAV の長さは ${BLOCK_SECONDS} 秒の倍数で指定します: ${seconds}`)
  const block = Buffer.from(speechBlock(sampleRate, channels, sampleRate + channels).buffer)
  const dataBytes = block.length * (seconds / BLOCK_SECONDS)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const fd = openSync(file, 'w')
  try {
    writeSync(fd, header)
    for (let i = 0; i < seconds / BLOCK_SECONDS; i++) writeSync(fd, block)
  } finally {
    closeSync(fd)
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  if (result.error?.code === 'ENOENT') throw new Error(`${command} がありません。このファイルを作るには ${command} が要ります`)
  if (result.status !== 0) throw new Error(`${command} が失敗しました (${result.status}): ${String(result.stderr).trim()}`)
}

/** An ID3v2.4 tag with a title and an artist, padded as taggers leave room to edit it in place. */
function id3(title, artist) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')])
    const header = Buffer.alloc(10)
    header.write(id, 0)
    header.writeUInt32BE(syncsafe(body.length), 4)
    return Buffer.concat([header, body])
  }
  const frames = Buffer.concat([frame('TIT2', title), frame('TPE1', artist), Buffer.alloc(2048)])
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])
  header.writeUInt32BE(syncsafe(frames.length), 6)
  return Buffer.concat([header, frames])
}
const syncsafe = (n) => (n & 0x7f) | ((n & 0x3f80) << 1) | ((n & 0x1fc000) << 2) | ((n & 0xfe00000) << 3)

/**
 * A 128 kbps joint-stereo MP3 of `seconds`, a whole number of ten-minute blocks, with an ID3 tag. lame writes no
 * Xing header (-t): a copied header would claim ten minutes for the whole file, and without one the length is
 * read from the bitrate, as it is for any constant-bitrate MP3.
 */
export function writeMp3(file, { seconds, title, artist }) {
  if (seconds % BLOCK_SECONDS !== 0) throw new Error(`MP3 の長さは ${BLOCK_SECONDS} 秒の倍数で指定します: ${seconds}`)
  const wav = `${file}.block.wav`
  const mp3 = `${file}.block.mp3`
  try {
    writeWav(wav, { seconds: BLOCK_SECONDS, sampleRate: 44_100, channels: 2 })
    run('lame', ['--quiet', '-t', '-b', '128', '-m', 'j', wav, mp3])
    const block = readFileSync(mp3)
    const fd = openSync(file, 'w')
    try {
      writeSync(fd, id3(title, artist))
      for (let i = 0; i < seconds / BLOCK_SECONDS; i++) writeSync(fd, block)
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(wav, { force: true })
    rmSync(mp3, { force: true })
  }
}

/** A voice memo as an iPhone records one: AAC at 64 kbps, mono, 48 kHz, in an MPEG-4 file. */
export function writeM4a(file, { seconds }) {
  const wav = `${file}.source.wav`
  try {
    writeWav(wav, { seconds, sampleRate: 48_000, channels: 1 })
    run('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', wav, file])
  } finally {
    rmSync(wav, { force: true })
  }
}
