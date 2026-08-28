import {
  bitModelTotal,
  moveBits,
  topValue,
  uint32Size,
  dictionarySize,
  lc,
  posStates,
  posStateMask,
  numStates,
  numLenToPosStates,
  numPosSlotBits,
  numAlignBits,
  alignTableSize,
  startPosModelIndex,
  endPosModelIndex,
  numFullDistances,
  matchMinLength,
  lowLengthSymbols,
  midLengthSymbols,
  highLengthSymbols,
  literalModelSize,
  literalContexts,
} from './constants.ts'

const createProbabilities = (size: number) => {
  const probabilities = new Uint16Array(size)
  probabilities.fill(bitModelTotal >> 1)
  return probabilities
}

class RangeDecoder {
  private code = 0
  private offset: number
  private range = 0xffff_ffff

  constructor(private readonly input: Uint8Array, offset: number) {
    this.offset = offset
    if (input.length - offset < 5) {
      throw new Error('Truncated LZMA range stream')
    }
    for (let index = 0; index < 5; index++) {
      this.code = (this.code * 0x100 + this.readByte()) % uint32Size
    }
  }

  decodeBit(probabilities: Uint16Array, index: number) {
    const probability = probabilities[index]!
    const bound = Math.floor(this.range / bitModelTotal) * probability
    let bit: number
    if (this.code < bound) {
      this.range = bound
      probabilities[index] = probability + ((bitModelTotal - probability) >> moveBits)
      bit = 0
    } else {
      this.range -= bound
      this.code -= bound
      probabilities[index] = probability - (probability >> moveBits)
      bit = 1
    }
    this.normalize()
    return bit
  }

  decodeDirectBits(bitCount: number) {
    let result = 0
    for (let index = 0; index < bitCount; index++) {
      this.range = Math.floor(this.range / 2)
      let bit = 0
      if (this.code >= this.range) {
        this.code -= this.range
        bit = 1
      }
      this.normalize()
      result = result * 2 + bit
    }
    return result
  }

  private normalize() {
    if (this.range < topValue) {
      this.range *= 0x100
      this.code = (this.code * 0x100 + this.readByte()) % uint32Size
    }
  }

  private readByte() {
    if (this.offset >= this.input.length) {
      throw new Error('Truncated LZMA range stream')
    }
    return this.input[this.offset++]!
  }
}


const decodeBitTree = (
  decoder: RangeDecoder,
  probabilities: Uint16Array,
  offset: number,
  bitCount: number,
) => {
  let model = 1
  for (let index = 0; index < bitCount; index++) {
    model = model * 2 + decoder.decodeBit(probabilities, offset + model)
  }
  return model - 2 ** bitCount
}


const decodeReverseBitTree = (
  decoder: RangeDecoder,
  probabilities: Uint16Array,
  offset: number,
  bitCount: number,
) => {
  let model = 1
  let symbol = 0
  for (let index = 0; index < bitCount; index++) {
    const bit = decoder.decodeBit(probabilities, offset + model)
    model = model * 2 + bit
    symbol += bit * 2 ** index
  }
  return symbol
}


const updateLiteralState = (state: number) => {
  if (state < 4) {
    return 0
  }
  if (state < 10) {
    return state - 3
  }
  return state - 6
}

const updateMatchState = (state: number) => state < 7 ? 7 : 10
const updateRepState = (state: number) => state < 7 ? 8 : 11
const updateShortRepState = (state: number) => state < 7 ? 9 : 11
const isLiteralState = (state: number) => state < 7
const lengthToPosState = (length: number) => Math.min(length - matchMinLength, numLenToPosStates - 1)

class LengthModels {
  readonly choice = createProbabilities(2)
  readonly high = createProbabilities(highLengthSymbols)
  readonly low = createProbabilities(posStates * lowLengthSymbols)
  readonly mid = createProbabilities(posStates * midLengthSymbols)
}

class Models {
  readonly align = createProbabilities(alignTableSize)
  readonly distance = createProbabilities(numFullDistances - endPosModelIndex)
  readonly isMatch = createProbabilities(numStates * posStates)
  readonly isRep = createProbabilities(numStates)
  readonly isRepG0 = createProbabilities(numStates)
  readonly isRepG1 = createProbabilities(numStates)
  readonly isRepG2 = createProbabilities(numStates)
  readonly isRep0Long = createProbabilities(numStates * posStates)
  readonly length = new LengthModels()
  readonly literal = createProbabilities(literalContexts * literalModelSize)
  readonly posSlot = createProbabilities(numLenToPosStates * (1 << numPosSlotBits))
  readonly repLength = new LengthModels()
}

const decodeLength = (decoder: RangeDecoder, models: LengthModels, posState: number) => {
  if (decoder.decodeBit(models.choice, 0) === 0) {
    return matchMinLength + decodeBitTree(decoder, models.low, posState * lowLengthSymbols, 3)
  }
  if (decoder.decodeBit(models.choice, 1) === 0) {
    return matchMinLength + lowLengthSymbols + decodeBitTree(decoder, models.mid, posState * midLengthSymbols, 3)
  }
  return matchMinLength + lowLengthSymbols + midLengthSymbols + decodeBitTree(decoder, models.high, 0, 8)
}

const literalContextOffset = (previousByte: number) => (previousByte >>> (8 - lc)) * literalModelSize
const decodeLiteral = (
  decoder: RangeDecoder,
  models: Models,
  previousByte: number,
  matchByte: number | undefined,
) => {
  const offset = literalContextOffset(previousByte)
  let symbol = 1
  if (matchByte === undefined) {
    while (symbol < 0x100) {
      symbol = symbol * 2 + decoder.decodeBit(models.literal, offset + symbol)
    }
    return symbol - 0x100
  }

  let match = matchByte
  while (symbol < 0x100) {
    match *= 2
    const matchBit = match & 0x100
    const bit = decoder.decodeBit(models.literal, offset + 0x100 + matchBit + symbol)
    symbol = symbol * 2 + bit
    if (matchBit !== bit * 0x100) {
      while (symbol < 0x100) {
        symbol = symbol * 2 + decoder.decodeBit(models.literal, offset + symbol)
      }
      break
    }
  }
  return symbol - 0x100
}

const decodeDistance = (decoder: RangeDecoder, models: Models, length: number) => {
  const lengthState = lengthToPosState(length)
  const slot = decodeBitTree(decoder, models.posSlot, lengthState << numPosSlotBits, numPosSlotBits)
  if (slot < startPosModelIndex) {
    return slot
  }

  const directBits = (slot >>> 1) - 1
  let distance = (2 | (slot & 1)) * 2 ** directBits
  if (slot < endPosModelIndex) {
    distance += decodeReverseBitTree(decoder, models.distance, distance - slot - 1, directBits)
    return distance
  }

  distance += decoder.decodeDirectBits(directBits - numAlignBits) * alignTableSize
  distance += decodeReverseBitTree(decoder, models.align, 0, numAlignBits)
  return distance
}

const decodeRawLzma = (input: Uint8Array, offset: number, outputLength: number) => {
  if (outputLength === 0) {
    return new Uint8Array()
  }

  const models = new Models()
  const decoder = new RangeDecoder(input, offset)
  const output = new Uint8Array(outputLength)
  const reps = [0, 0, 0, 0]
  let state = 0
  let position = 0

  while (position < outputLength) {
    const posState = position & posStateMask
    const statePosIndex = state * posStates + posState
    if (decoder.decodeBit(models.isMatch, statePosIndex) === 0) {
      const previousByte = position === 0 ? 0 : output[position - 1]!
      const matchByte = !isLiteralState(state) && reps[0]! + 1 <= position
        ? output[position - reps[0]! - 1]
        : undefined
      output[position++] = decodeLiteral(decoder, models, previousByte, matchByte)
      state = updateLiteralState(state)
      continue
    }

    let length: number
    if (decoder.decodeBit(models.isRep, state) === 1) {
      if (decoder.decodeBit(models.isRepG0, state) === 0) {
        if (decoder.decodeBit(models.isRep0Long, statePosIndex) === 0) {
          const distance = reps[0]! + 1
          if (distance > position || distance > dictionarySize) {
            throw new Error('Invalid LZMA short-repetition distance')
          }
          output[position] = output[position - distance]!
          position++
          state = updateShortRepState(state)
          continue
        }
      } else {
        let repIndex: number
        if (decoder.decodeBit(models.isRepG1, state) === 0) {
          repIndex = 1
        } else if (decoder.decodeBit(models.isRepG2, state) === 0) {
          repIndex = 2
        } else {
          repIndex = 3
        }
        const distance = reps[repIndex]!
        for (let index = repIndex; index > 0; index--) {
          reps[index] = reps[index - 1]!
        }
        reps[0] = distance
      }
      length = decodeLength(decoder, models.repLength, posState)
      state = updateRepState(state)
    } else {
      length = decodeLength(decoder, models.length, posState)
      const distance = decodeDistance(decoder, models, length)
      reps[3] = reps[2]!
      reps[2] = reps[1]!
      reps[1] = reps[0]!
      reps[0] = distance
      state = updateMatchState(state)
    }

    const distance = reps[0]! + 1
    if (distance > position || distance > dictionarySize) {
      throw new Error('Invalid LZMA match distance')
    }
    if (position + length > outputLength) {
      throw new Error('LZMA match exceeds declared output length')
    }
    for (let index = 0; index < length; index++) {
      output[position] = output[position - distance]!
      position++
    }
  }

  return output
}




export const defaultMaxOutputLength = 0xffff_ffff

const decodeOutputLength = (input: Uint8Array) => {
  let length = 0
  let multiplier = 1
  for (let offset = 0; offset < Math.min(input.length, 5); offset++) {
    const byte = input[offset]!
    length += (byte & 0x7f) * multiplier
    if (length > 0xffff_ffff) {
      throw new Error('Declared output length is too large')
    }
    if ((byte & 0x80) === 0) {
      return {length, offset: offset + 1}
    }
    multiplier *= 0x80
  }
  throw new Error('Invalid output-length varint')
}

export const decompress = (input: Uint8Array, maxOutputLength = defaultMaxOutputLength) => {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('decompress() expects a Uint8Array')
  }
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 0) {
    throw new RangeError('maxOutputLength must be a non-negative safe integer')
  }

  const {length, offset} = decodeOutputLength(input)
  if (length > maxOutputLength) {
    throw new RangeError(`Declared output length ${length} exceeds the ${maxOutputLength} byte safety limit`)
  }
  if (length === 0) {
    if (offset !== input.length) {
      throw new Error('Unexpected payload after empty LZMA value')
    }
    return new Uint8Array()
  }
  return decodeRawLzma(input, offset, length)
}

export const unpackLzma = decompress
export default decompress

export {dictionarySize, lc, lp, pb} from './constants.ts'
