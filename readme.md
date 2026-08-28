# lzma-8m

Small, dependency-free LZMA1 codec for binary URL-state payloads.

The codec is intentionally fixed rather than configurable:

- input and output are `Uint8Array`
- 8 MiB LZMA dictionary
- `lc=3`, `lp=0`, `pb=0`
- 384-deep hash-chain search with a price-aware dynamic parser
- no `.xz` or `.lzma` container overhead
- unsigned-varint uncompressed length followed by the raw LZMA range stream
- decompression accepts the full 32-bit framed output range by default; pass an explicit limit when decoding untrusted data

```ts
import {compress, decompress} from 'lzma-8m'

const packed: Uint8Array = getMsgpackBytes()
const encoded = compress(packed)
const decoded = decompress(encoded)
```

`compress` is also the default export. The framing is package-specific; it is meant for compact application state rather than `.xz`/`.lzma` file interchange.
