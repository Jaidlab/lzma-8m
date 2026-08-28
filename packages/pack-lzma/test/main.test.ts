import {describe, expect, test} from 'bun:test'

import packLzma, {dictionarySize} from '../src/main.ts'

const encoder = new TextEncoder()

describe('packLzma', () => {
  test('uses the fixed 8 MiB dictionary', () => {
    expect(dictionarySize).toBe(8 * 1024 * 1024)
  })

  test('produces deterministic framed LZMA bytes', () => {
    const input = encoder.encode('hello world')
    const expected = Uint8Array.of(11, 0, 52, 26, 21, 65, 24, 184, 98, 119, 144, 193, 21, 227, 32, 143, 96)
    expect(packLzma(input)).toEqual(expected)
    expect(packLzma(input)).toEqual(expected)
  })

  test('encodes empty input as a zero length frame', () => {
    expect(packLzma(new Uint8Array())).toEqual(Uint8Array.of(0))
  })
})