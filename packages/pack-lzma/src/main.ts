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
  matchMaxLength,
  lowLengthSymbols,
  midLengthSymbols,
  highLengthSymbols,
  literalModelSize,
  literalContexts,
} from 'unpack-lzma/constants'

const createProbabilities = (size: number) => {
  const probabilities = new Uint16Array(size)
  probabilities.fill(bitModelTotal >> 1)
  return probabilities
}

class ByteWriter {
  private buffer: Uint8Array
  private length = 0

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(Math.max(16, initialCapacity))
  }

  push(value: number) {
    if (this.length === this.buffer.length) {
      const next = new Uint8Array(this.buffer.length * 2)
      next.set(this.buffer)
      this.buffer = next
    }
    this.buffer[this.length++] = value
  }

  finish() {
    return this.buffer.slice(0, this.length)
  }
}

class RangeEncoder {
  private cache = 0
  private cacheSize = 1
  private low = 0
  private range = 0xffff_ffff
  private readonly writer: ByteWriter

  constructor(expectedSize = 1024) {
    this.writer = new ByteWriter(expectedSize)
  }

  encodeBit(probabilities: Uint16Array, index: number, bit: number) {
    const probability = probabilities[index]!
    const bound = Math.floor(this.range / bitModelTotal) * probability
    if (bit === 0) {
      this.range = bound
      probabilities[index] = probability + ((bitModelTotal - probability) >> moveBits)
    } else {
      this.low += bound
      this.range -= bound
      probabilities[index] = probability - (probability >> moveBits)
    }
    if (this.range < topValue) {
      this.range *= 0x100
      this.shiftLow()
    }
  }

  encodeDirectBits(value: number, bitCount: number) {
    for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex--) {
      this.range = Math.floor(this.range / 2)
      const bit = Math.floor(value / 2 ** bitIndex) & 1
      if (bit !== 0) {
        this.low += this.range
      }
      if (this.range < topValue) {
        this.range *= 0x100
        this.shiftLow()
      }
    }
  }

  finish() {
    for (let index = 0; index < 5; index++) {
      this.shiftLow()
    }
    return this.writer.finish()
  }

  private shiftLow() {
    const low32 = this.low >>> 0
    const high = Math.floor(this.low / uint32Size)
    if (low32 < 0xff00_0000 || high !== 0) {
      let temporary = this.cache
      do {
        this.writer.push((temporary + high) & 0xff)
        temporary = 0xff
        this.cacheSize--
      } while (this.cacheSize !== 0)
      this.cache = low32 >>> 24
    }
    this.cacheSize++
    this.low = (low32 * 0x100) % uint32Size
  }
}


const encodeBitTree = (
  encoder: RangeEncoder,
  probabilities: Uint16Array,
  offset: number,
  bitCount: number,
  symbol: number,
) => {
  let model = 1
  for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex--) {
    const bit = Math.floor(symbol / 2 ** bitIndex) & 1
    encoder.encodeBit(probabilities, offset + model, bit)
    model = model * 2 + bit
  }
}


const encodeReverseBitTree = (
  encoder: RangeEncoder,
  probabilities: Uint16Array,
  offset: number,
  bitCount: number,
  symbol: number,
) => {
  let model = 1
  for (let index = 0; index < bitCount; index++) {
    const bit = Math.floor(symbol / 2 ** index) & 1
    encoder.encodeBit(probabilities, offset + model, bit)
    model = model * 2 + bit
  }
}



const hash4Bits = 20
const hash4Size = 1 << hash4Bits
const hash3Bits = 18
const hash3Size = 1 << hash3Bits
const matchDepth = 384
const match3Depth = 64
const parserHorizon = 192
const shortLengthLimit = 16
const lengthAnchors = [20, 24, 32, 48, 64, 96, 128, 160, 192, 224, 273] as const
const bitPrices = new Array<number>((bitModelTotal + 1) * 2).fill(0)
for (let probability = 1; probability < bitModelTotal; probability++) {
  bitPrices[probability * 2] = -Math.log2(probability / bitModelTotal)
  bitPrices[probability * 2 + 1] = -Math.log2((bitModelTotal - probability) / bitModelTotal)
}

const bitPrice = (probabilities: Uint16Array, index: number, bit: number) => bitPrices[(probabilities[index]! << 1) | bit]!

const bitTreePrice = (probabilities: Uint16Array, offset: number, bitCount: number, symbol: number) => {
  let model = 1
  let price = 0
  for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex--) {
    const bit = Math.floor(symbol / 2 ** bitIndex) & 1
    price += bitPrice(probabilities, offset + model, bit)
    model = model * 2 + bit
  }
  return price
}

const reverseBitTreePrice = (probabilities: Uint16Array, offset: number, bitCount: number, symbol: number) => {
  let model = 1
  let price = 0
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const bit = Math.floor(symbol / 2 ** bitIndex) & 1
    price += bitPrice(probabilities, offset + model, bit)
    model = model * 2 + bit
  }
  return price
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

const encodeLength = (encoder: RangeEncoder, models: LengthModels, length: number, posState: number) => {
  let symbol = length - matchMinLength
  if (symbol < lowLengthSymbols) {
    encoder.encodeBit(models.choice, 0, 0)
    encodeBitTree(encoder, models.low, posState * lowLengthSymbols, 3, symbol)
    return
  }
  encoder.encodeBit(models.choice, 0, 1)
  symbol -= lowLengthSymbols
  if (symbol < midLengthSymbols) {
    encoder.encodeBit(models.choice, 1, 0)
    encodeBitTree(encoder, models.mid, posState * midLengthSymbols, 3, symbol)
    return
  }
  encoder.encodeBit(models.choice, 1, 1)
  encodeBitTree(encoder, models.high, 0, 8, symbol - midLengthSymbols)
}

const literalContextOffset = (previousByte: number) => (previousByte >>> (8 - lc)) * literalModelSize

const encodeLiteral = (
  encoder: RangeEncoder,
  models: Models,
  byte: number,
  previousByte: number,
  matchByte: number | undefined,
) => {
  const offset = literalContextOffset(previousByte)
  if (matchByte === undefined) {
    let symbol = byte | 0x100
    while (symbol < 0x1_0000) {
      encoder.encodeBit(models.literal, offset + (symbol >>> 8), (symbol >>> 7) & 1)
      symbol *= 2
    }
    return
  }

  let symbol = byte | 0x100
  let match = matchByte
  while (symbol < 0x1_0000) {
    match *= 2
    const matchBit = match & 0x100
    const bit = (symbol >>> 7) & 1
    encoder.encodeBit(models.literal, offset + 0x100 + matchBit + (symbol >>> 8), bit)
    symbol *= 2
    if (matchBit !== bit * 0x100) {
      while (symbol < 0x1_0000) {
        encoder.encodeBit(models.literal, offset + (symbol >>> 8), (symbol >>> 7) & 1)
        symbol *= 2
      }
      break
    }
  }
}

const getPosSlot = (distance: number) => {
  if (distance < 4) {
    return distance
  }
  const log = Math.floor(Math.log2(distance))
  return log * 2 + (Math.floor(distance / 2 ** (log - 1)) & 1)
}

const encodeDistance = (encoder: RangeEncoder, models: Models, distance: number, length: number) => {
  const lengthState = lengthToPosState(length)
  const slot = getPosSlot(distance)
  encodeBitTree(encoder, models.posSlot, lengthState << numPosSlotBits, numPosSlotBits, slot)
  if (slot < startPosModelIndex) {
    return
  }

  const directBits = (slot >>> 1) - 1
  const base = (2 | (slot & 1)) * 2 ** directBits
  const reduced = distance - base
  if (slot < endPosModelIndex) {
    encodeReverseBitTree(encoder, models.distance, base - slot - 1, directBits, reduced)
    return
  }

  encoder.encodeDirectBits(Math.floor(reduced / alignTableSize), directBits - numAlignBits)
  encodeReverseBitTree(encoder, models.align, 0, numAlignBits, reduced & (alignTableSize - 1))
}

const hash3 = (input: Uint8Array, position: number) => {
  const value = input[position]! | (input[position + 1]! << 8) | (input[position + 2]! << 16)
  return (Math.imul(value, 0x9e37_79b1) >>> 0) >>> (32 - hash3Bits)
}

const hash4 = (input: Uint8Array, position: number) => {
  const value = (
    input[position]!
    | (input[position + 1]! << 8)
    | (input[position + 2]! << 16)
    | (input[position + 3]! << 24)
  ) >>> 0
  const mixed = Math.imul((value ^ (value >>> 15)) >>> 0, 0x9e37_79b1) >>> 0
  return mixed >>> (32 - hash4Bits)
}

type Match = {
  distance: number
  length: number
}

class MatchFinder {
  private readonly head2 = new Uint32Array(1 << 16)
  private readonly head3 = new Uint32Array(hash3Size)
  private readonly head4 = new Uint32Array(hash4Size)
  private readonly historySize: number
  private readonly previous2: Uint32Array
  private readonly previous3: Uint32Array
  private readonly previous4: Uint32Array
  private nextInsertPosition = 0

  constructor(private readonly input: Uint8Array) {
    this.historySize = Math.min(input.length, dictionarySize + 1)
    this.previous2 = new Uint32Array(this.historySize)
    this.previous3 = new Uint32Array(this.historySize)
    this.previous4 = new Uint32Array(this.historySize)
  }

  find(position: number): Match[] {
    this.insertUntil(position)
    const limit = Math.min(matchMaxLength, this.input.length - position)
    if (limit < matchMinLength) return []

    const matches: Match[] = []
    let bestLength = 0
    let bestDistance = 0
    const consider = (length: number, distance: number) => {
      if (length < matchMinLength) return false
      const encodedDistance = distance - 1
      if (length > bestLength) {
        bestLength = length
        bestDistance = encodedDistance
        matches.push({distance: encodedDistance, length})
        return length === limit
      }
      if (length === bestLength && encodedDistance < bestDistance) {
        bestDistance = encodedDistance
        if (matches.length && matches[matches.length - 1]!.length === length) {
          matches[matches.length - 1] = {distance: encodedDistance, length}
        }
      }
      return false
    }

    const ringIndex = position % this.historySize
    const previous2 = this.previous2[ringIndex]!
    if (previous2 !== 0) {
      const candidate = previous2 - 1
      const distance = position - candidate
      if (distance <= dictionarySize) {
        let length = 2
        while (length < limit && this.input[candidate + length] === this.input[position + length]) length++
        if (consider(length, distance)) return matches
      }
    }

    if (limit >= 3) {
      let link = this.previous3[ringIndex]!
      let depth = 0
      while (link !== 0 && depth++ < match3Depth) {
        const candidate = link - 1
        const distance = position - candidate
        if (distance > dictionarySize) break
        if (this.input[candidate] === this.input[position] && this.input[candidate + 1] === this.input[position + 1] && this.input[candidate + 2] === this.input[position + 2]) {
          let length = 3
          while (length < limit && this.input[candidate + length] === this.input[position + length]) length++
          if (consider(length, distance)) return matches
        }
        link = this.previous3[candidate % this.historySize]!
      }
    }

    if (limit >= 4) {
      let link = this.previous4[ringIndex]!
      let depth = 0
      while (link !== 0 && depth++ < matchDepth) {
        const candidate = link - 1
        const distance = position - candidate
        if (distance > dictionarySize) break
        if (this.input[candidate] === this.input[position] && this.input[candidate + 1] === this.input[position + 1] && this.input[candidate + 2] === this.input[position + 2] && this.input[candidate + 3] === this.input[position + 3]) {
          let length = 4
          while (length < limit && this.input[candidate + length] === this.input[position + length]) length++
          if (consider(length, distance)) break
        }
        link = this.previous4[candidate % this.historySize]!
      }
    }
    return matches
  }

  private insertUntil(position: number) {
    while (this.nextInsertPosition <= position) {
      const current = this.nextInsertPosition++
      const ringIndex = current % this.historySize
      if (current + 1 < this.input.length) {
        const key = this.input[current]! | (this.input[current + 1]! << 8)
        this.previous2[ringIndex] = this.head2[key]!
        this.head2[key] = current + 1
      } else this.previous2[ringIndex] = 0
      if (current + 2 < this.input.length) {
        const key = hash3(this.input, current)
        this.previous3[ringIndex] = this.head3[key]!
        this.head3[key] = current + 1
      } else this.previous3[ringIndex] = 0
      if (current + 3 < this.input.length) {
        const key = hash4(this.input, current)
        this.previous4[ringIndex] = this.head4[key]!
        this.head4[key] = current + 1
      } else this.previous4[ringIndex] = 0
    }
  }
}

const getRepLength = (input: Uint8Array, position: number, distance: number) => {
  const actualDistance = distance + 1
  if (actualDistance > position || actualDistance > dictionarySize) return 0
  const limit = Math.min(matchMaxLength, input.length - position)
  const candidate = position - actualDistance
  let length = 0
  while (length < limit && input[candidate + length] === input[position + length]) length++
  return length
}

type Action =
  | {kind: 'literal', length: 1}
  | {kind: 'match', distance: number, length: number}
  | {kind: 'rep', index: number, length: number}

const selectedLengths = Array.from({length: matchMaxLength + 1}, (_, maximum) => {
  const result: number[] = []
  const add = (length: number) => {
    if (length >= matchMinLength && length <= maximum && result[result.length - 1] !== length && !result.includes(length)) result.push(length)
  }
  for (let length = matchMinLength; length <= Math.min(maximum, shortLengthLimit); length++) add(length)
  for (const length of lengthAnchors) add(length)
  for (let length = Math.max(matchMinLength, maximum - 3); length <= maximum; length++) add(length)
  result.sort((a, b) => a - b)
  return result
})

const lengthPrice = (models: LengthModels, length: number, posState: number) => {
  let symbol = length - matchMinLength
  if (symbol < lowLengthSymbols) return bitPrice(models.choice, 0, 0) + bitTreePrice(models.low, posState * lowLengthSymbols, 3, symbol)
  let price = bitPrice(models.choice, 0, 1)
  symbol -= lowLengthSymbols
  if (symbol < midLengthSymbols) return price + bitPrice(models.choice, 1, 0) + bitTreePrice(models.mid, posState * midLengthSymbols, 3, symbol)
  return price + bitPrice(models.choice, 1, 1) + bitTreePrice(models.high, 0, 8, symbol - midLengthSymbols)
}

const distancePrice = (models: Models, distance: number, length: number) => {
  const lengthState = lengthToPosState(length)
  const slot = getPosSlot(distance)
  let price = bitTreePrice(models.posSlot, lengthState << numPosSlotBits, numPosSlotBits, slot)
  if (slot < startPosModelIndex) return price
  const directBits = (slot >>> 1) - 1
  const base = (2 | (slot & 1)) * 2 ** directBits
  const reduced = distance - base
  if (slot < endPosModelIndex) return price + reverseBitTreePrice(models.distance, base - slot - 1, directBits, reduced)
  price += directBits - numAlignBits
  return price + reverseBitTreePrice(models.align, 0, numAlignBits, reduced & (alignTableSize - 1))
}

const literalPrice = (input: Uint8Array, models: Models, position: number, state: number, rep0: number, prefixPrice: number) => {
  let price = prefixPrice
  const previousByte = position === 0 ? 0 : input[position - 1]!
  const offset = literalContextOffset(previousByte)
  const byte = input[position]!
  const matchByte = !isLiteralState(state) && rep0 + 1 <= position ? input[position - rep0 - 1] : undefined
  if (matchByte === undefined) {
    let symbol = byte | 0x100
    while (symbol < 0x1_0000) {
      const bit = (symbol >>> 7) & 1
      price += bitPrice(models.literal, offset + (symbol >>> 8), bit)
      symbol *= 2
    }
    return price
  }
  let symbol = byte | 0x100
  let match = matchByte
  while (symbol < 0x1_0000) {
    match *= 2
    const matchBit = match & 0x100
    const bit = (symbol >>> 7) & 1
    price += bitPrice(models.literal, offset + 0x100 + matchBit + (symbol >>> 8), bit)
    symbol *= 2
    if (matchBit !== bit * 0x100) {
      while (symbol < 0x1_0000) {
        const tailBit = (symbol >>> 7) & 1
        price += bitPrice(models.literal, offset + (symbol >>> 8), tailBit)
        symbol *= 2
      }
      break
    }
  }
  return price
}

const planActions = (input: Uint8Array, models: Models, finder: MatchFinder, position: number, state: number, reps: readonly number[]) => {
  const horizon = Math.min(parserHorizon, input.length - position)
  const costs = new Float64Array(horizon + 1)
  costs.fill(Number.POSITIVE_INFINITY)
  costs[0] = 0
  const states = new Uint8Array(horizon + 1)
  states[0] = state
  const rep0 = new Uint32Array(horizon + 1)
  const rep1 = new Uint32Array(horizon + 1)
  const rep2 = new Uint32Array(horizon + 1)
  const rep3 = new Uint32Array(horizon + 1)
  rep0[0] = reps[0]!
  rep1[0] = reps[1]!
  rep2[0] = reps[2]!
  rep3[0] = reps[3]!
  const previousOffsets = new Uint16Array(horizon + 1)
  const actionKinds = new Uint8Array(horizon + 1)
  const actionLengths = new Uint16Array(horizon + 1)
  const actionValues = new Uint32Array(horizon + 1)
  const matches = new Array<Match[] | undefined>(horizon)
  const literalPrefixes = new Float64Array(numStates)
  const matchPrefixes = new Float64Array(numStates)
  const repPrefixes = new Float64Array(numStates * 4)
  const shortRepPrefixes = new Float64Array(numStates)
  for (let parserState = 0; parserState < numStates; parserState++) {
    const statePosIndex = parserState * posStates
    literalPrefixes[parserState] = bitPrice(models.isMatch, statePosIndex, 0)
    const matchBitPrice = bitPrice(models.isMatch, statePosIndex, 1)
    matchPrefixes[parserState] = matchBitPrice + bitPrice(models.isRep, parserState, 0)
    const repBase = matchBitPrice + bitPrice(models.isRep, parserState, 1)
    const rep0Base = repBase + bitPrice(models.isRepG0, parserState, 0)
    shortRepPrefixes[parserState] = rep0Base + bitPrice(models.isRep0Long, statePosIndex, 0)
    repPrefixes[parserState * 4] = rep0Base + bitPrice(models.isRep0Long, statePosIndex, 1)
    const otherRepBase = repBase + bitPrice(models.isRepG0, parserState, 1)
    repPrefixes[parserState * 4 + 1] = otherRepBase + bitPrice(models.isRepG1, parserState, 0)
    const distantRepBase = otherRepBase + bitPrice(models.isRepG1, parserState, 1)
    repPrefixes[parserState * 4 + 2] = distantRepBase + bitPrice(models.isRepG2, parserState, 0)
    repPrefixes[parserState * 4 + 3] = distantRepBase + bitPrice(models.isRepG2, parserState, 1)
  }
  const normalLengthPrices = new Float64Array(matchMaxLength + 1)
  const repLengthPrices = new Float64Array(matchMaxLength + 1)

  for (let offset = 0; offset < horizon; offset++) {
    const nodeCost = costs[offset]!
    if (!Number.isFinite(nodeCost)) continue
    const absolutePosition = position + offset
    const remaining = horizon - offset
    const nodeState = states[offset]!
    const r0 = rep0[offset]!
    const r1 = rep1[offset]!
    const r2 = rep2[offset]!
    const r3 = rep3[offset]!
    const update = (length: number, addedCost: number, nextState: number, nr0: number, nr1: number, nr2: number, nr3: number, kind: number, value: number) => {
      const nextOffset = offset + length
      if (nextOffset > horizon) return
      const cost = nodeCost + addedCost
      if (cost >= costs[nextOffset]!) return
      costs[nextOffset] = cost
      states[nextOffset] = nextState
      rep0[nextOffset] = nr0
      rep1[nextOffset] = nr1
      rep2[nextOffset] = nr2
      rep3[nextOffset] = nr3
      previousOffsets[nextOffset] = offset
      actionKinds[nextOffset] = kind
      actionLengths[nextOffset] = length
      actionValues[nextOffset] = value
    }

    update(1, literalPrice(input, models, absolutePosition, nodeState, r0, literalPrefixes[nodeState]!), updateLiteralState(nodeState), r0, r1, r2, r3, 1, 0)
    const repLengths = [
      Math.min(remaining, getRepLength(input, absolutePosition, r0)),
      Math.min(remaining, getRepLength(input, absolutePosition, r1)),
      Math.min(remaining, getRepLength(input, absolutePosition, r2)),
      Math.min(remaining, getRepLength(input, absolutePosition, r3)),
    ]
    if (repLengths[0]! >= 1) update(1, shortRepPrefixes[nodeState]!, updateShortRepState(nodeState), r0, r1, r2, r3, 3, 0)
    for (let index = 0; index < 4; index++) {
      const maximum = repLengths[index]!
      if (maximum < matchMinLength) continue
      for (const length of selectedLengths[maximum]!) {
        let repLengthCost = repLengthPrices[length]!
        if (repLengthCost === 0) {
          repLengthCost = lengthPrice(models.repLength, length, 0)
          repLengthPrices[length] = repLengthCost
        }
        if (index === 0) update(length, repPrefixes[nodeState * 4 + 0]! + repLengthCost, updateRepState(nodeState), r0, r1, r2, r3, 3, 0)
        else if (index === 1) update(length, repPrefixes[nodeState * 4 + 1]! + repLengthCost, updateRepState(nodeState), r1, r0, r2, r3, 3, 1)
        else if (index === 2) update(length, repPrefixes[nodeState * 4 + 2]! + repLengthCost, updateRepState(nodeState), r2, r0, r1, r3, 3, 2)
        else update(length, repPrefixes[nodeState * 4 + 3]! + repLengthCost, updateRepState(nodeState), r3, r0, r1, r2, 3, 3)
      }
    }

    matches[offset] ??= finder.find(absolutePosition)
    let previousMaximum = 1
    for (const match of matches[offset]!) {
      const maximum = Math.min(match.length, remaining)
      if (maximum < matchMinLength) continue
      const minimum = Math.max(matchMinLength, previousMaximum + 1)
      const distancePrices = new Float64Array(numLenToPosStates)
      for (const length of selectedLengths[maximum]!) {
        if (length < minimum) continue
        let normalLengthCost = normalLengthPrices[length]!
        if (normalLengthCost === 0) {
          normalLengthCost = lengthPrice(models.length, length, 0)
          normalLengthPrices[length] = normalLengthCost
        }
        const lengthState = lengthToPosState(length)
        let distanceCost = distancePrices[lengthState]!
        if (distanceCost === 0) {
          distanceCost = distancePrice(models, match.distance, length)
          distancePrices[lengthState] = distanceCost
        }
        update(length, matchPrefixes[nodeState]! + normalLengthCost + distanceCost, updateMatchState(nodeState), match.distance, r0, r1, r2, 2, match.distance)
      }
      previousMaximum = Math.max(previousMaximum, match.length)
    }
  }

  if (!Number.isFinite(costs[horizon]!)) throw new Error('LZMA parser failed to reach its horizon')
  const actions: Action[] = []
  let offset = horizon
  while (offset > 0) {
    const kind = actionKinds[offset]!
    const length = actionLengths[offset]!
    const value = actionValues[offset]!
    if (kind === 1) actions.push({kind: 'literal', length: 1})
    else if (kind === 2) actions.push({kind: 'match', distance: value, length})
    else if (kind === 3) actions.push({kind: 'rep', index: value, length})
    else throw new Error('LZMA parser produced an invalid path')
    offset = previousOffsets[offset]!
  }
  actions.reverse()
  return actions
}

const encodeRawLzma = (input: Uint8Array) => {
  if (input.length === 0) return new Uint8Array()
  const models = new Models()
  const encoder = new RangeEncoder(Math.min(1024 * 1024, Math.max(64, Math.ceil(input.length / 2))))
  const finder = new MatchFinder(input)
  const reps = [0, 0, 0, 0]
  let state = 0
  let position = 0
  while (position < input.length) {
    const actions = planActions(input, models, finder, position, state, reps)
    for (const action of actions) {
      const posState = position & posStateMask
      const statePosIndex = state * posStates + posState
      if (action.kind === 'literal') {
        encoder.encodeBit(models.isMatch, statePosIndex, 0)
        const previousByte = position === 0 ? 0 : input[position - 1]!
        const matchByte = !isLiteralState(state) && reps[0]! + 1 <= position ? input[position - reps[0]! - 1] : undefined
        encodeLiteral(encoder, models, input[position]!, previousByte, matchByte)
        state = updateLiteralState(state)
        position++
        continue
      }
      encoder.encodeBit(models.isMatch, statePosIndex, 1)
      if (action.kind === 'match') {
        encoder.encodeBit(models.isRep, state, 0)
        state = updateMatchState(state)
        encodeLength(encoder, models.length, action.length, posState)
        encodeDistance(encoder, models, action.distance, action.length)
        reps[3] = reps[2]!
        reps[2] = reps[1]!
        reps[1] = reps[0]!
        reps[0] = action.distance
        position += action.length
        continue
      }
      encoder.encodeBit(models.isRep, state, 1)
      if (action.index === 0) {
        encoder.encodeBit(models.isRepG0, state, 0)
        if (action.length === 1) {
          encoder.encodeBit(models.isRep0Long, statePosIndex, 0)
          state = updateShortRepState(state)
          position++
          continue
        }
        encoder.encodeBit(models.isRep0Long, statePosIndex, 1)
      } else {
        encoder.encodeBit(models.isRepG0, state, 1)
        if (action.index === 1) encoder.encodeBit(models.isRepG1, state, 0)
        else {
          encoder.encodeBit(models.isRepG1, state, 1)
          encoder.encodeBit(models.isRepG2, state, action.index === 2 ? 0 : 1)
        }
        const distance = reps[action.index]!
        for (let index = action.index; index > 0; index--) reps[index] = reps[index - 1]!
        reps[0] = distance
      }
      encodeLength(encoder, models.repLength, action.length, posState)
      state = updateRepState(state)
      position += action.length
    }
  }
  return encoder.finish()
}


const encodeOutputLength = (length: number) => {
  const bytes: number[] = []
  let value = length
  do {
    const byte = value % 0x80
    value = Math.floor(value / 0x80)
    bytes.push(byte | (value === 0 ? 0 : 0x80))
  } while (value !== 0)
  return bytes
}

export const compress = (input: Uint8Array) => {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('compress() expects a Uint8Array')
  }

  const header = encodeOutputLength(input.length)
  const compressed = encodeRawLzma(input)
  const output = new Uint8Array(header.length + compressed.length)
  output.set(header)
  output.set(compressed, header.length)
  return output
}

export const packLzma = compress
export default compress

export {dictionarySize} from 'unpack-lzma/constants'
