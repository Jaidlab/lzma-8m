import {expect, test} from 'bun:test'
import compress, {decompress, dictionarySize} from '#src/main.ts'

const encoder = new TextEncoder()

const roundTrip = (input: Uint8Array) => {
  const compressed = compress(input)
  const output = decompress(compressed)
  expect(Array.from(output)).toEqual(Array.from(input))
  return compressed
}

test('exports the fixed 8 MiB dictionary size', () => {
  expect(dictionarySize).toBe(8 * 1024 * 1024)
})

test('round-trips an empty Uint8Array', () => {
  expect(compress(new Uint8Array())).toEqual(Uint8Array.of(0))
  expect(decompress(Uint8Array.of(0))).toEqual(new Uint8Array())
})

test('round-trips short binary input', () => {
  roundTrip(Uint8Array.of(0, 1, 2, 3, 255, 0, 128, 64, 32, 16))
})

test('round-trips repetitive Markdown-like MessagePack bytes and compresses them', () => {
  const paragraph = '# Chapter\n\nThe quick brown fox jumps over the lazy dog. **Markdown** keeps repeating.\n\n'
  const input = encoder.encode(paragraph.repeat(128))
  const compressed = roundTrip(input)
  expect(compressed.length).toBeLessThan(input.length / 4)
})

test('round-trips deterministic noisy data', () => {
  const input = new Uint8Array(16 * 1024)
  let state = 0x1234_5678
  for (let index = 0; index < input.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    input[index] = state >>> 24
  }
  roundTrip(input)
})

test('honors the decompression safety limit', () => {
  const compressed = compress(encoder.encode('hello world'))
  expect(() => decompress(compressed, 5)).toThrow(RangeError)
})

test('rejects truncated input', () => {
  const compressed = compress(encoder.encode('some data that has to survive truncation detection'))
  expect(() => decompress(compressed.subarray(0, compressed.length - 2))).toThrow()
})
