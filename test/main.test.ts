import {expect, test} from 'bun:test'

const {default: lzma8M} = await import('#src/main.ts')

test('should run', () => {
  const result = lzma8M()
  expect(result).toBe('lzma-8m') // TODO Test actual functionality
})
