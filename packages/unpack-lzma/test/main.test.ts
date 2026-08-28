import {describe, expect, test} from 'bun:test'

import unpackLzma, {defaultMaxOutputLength, dictionarySize} from '../src/main.ts'

const helloWorldFixture = Uint8Array.of(11, 0, 52, 26, 21, 65, 24, 184, 98, 119, 144, 193, 21, 227, 32, 143, 96)

describe('unpackLzma', () => {
  test('uses the fixed 8 MiB dictionary and full 32-bit default limit', () => {
    expect(dictionarySize).toBe(8 * 1024 * 1024)
    expect(defaultMaxOutputLength).toBe(0xffff_ffff)
  })

  test('decodes a fixed pack-lzma fixture', () => {
    expect(new TextDecoder().decode(unpackLzma(helloWorldFixture))).toBe('hello world')
  })

  test('honors an explicit output safety limit', () => {
    expect(() => unpackLzma(helloWorldFixture, 5)).toThrow(RangeError)
  })

  test('rejects truncated payloads', () => {
    expect(() => unpackLzma(helloWorldFixture.subarray(0, helloWorldFixture.length - 2))).toThrow()
  })
})