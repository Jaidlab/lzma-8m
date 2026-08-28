import packLzma, {dictionarySize} from 'pack-lzma'
import unpackLzma, {defaultMaxOutputLength} from 'unpack-lzma'

export {defaultMaxOutputLength, dictionarySize}
export const compress = packLzma
export const decompress = unpackLzma
export default packLzma