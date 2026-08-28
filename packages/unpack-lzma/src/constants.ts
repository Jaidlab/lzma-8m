export const bitModelTotal = 1 << 11
export const moveBits = 5
export const topValue = 1 << 24
export const uint32Size = 0x1_0000_0000

export const dictionarySize = 8 * 1024 * 1024
export const lc = 3
export const lp = 0
export const pb = 0
export const numStates = 12
export const numLenToPosStates = 4
export const numPosSlotBits = 6
export const numAlignBits = 4
export const startPosModelIndex = 4
export const endPosModelIndex = 14
export const matchMinLength = 2
export const matchMaxLength = 273
export const lowLengthSymbols = 1 << 3
export const midLengthSymbols = 1 << 3
export const highLengthSymbols = 1 << 8
export const literalModelSize = 0x300

export const posStateBits = pb
export const posStates = 1 << posStateBits
export const posStateMask = posStates - 1
export const alignTableSize = 1 << numAlignBits
export const numFullDistances = 1 << (endPosModelIndex >> 1)
export const literalContexts = 1 << lc
