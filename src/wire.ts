/** Wire constants shared with dsh-proxy and the phone. See PROTOCOL.md. */

/** Preamble magic of a mobile client connection. */
export const MAGIC_CLIENT = Buffer.from('DSHC', 'ascii')
/** Preamble magic of a bridge connection. */
export const MAGIC_BRIDGE = Buffer.from('DSHB', 'ascii')
/** Protocol version carried by the preamble. */
export const VERSION = 1
/** magic(4) + ver(1) + key(32) */
export const HEAD_LEN = 37

/** mux frame kinds. */
export const KIND_OPEN = 0
export const KIND_DATA = 1
export const KIND_CLOSE = 2
export const KIND_WINDOW = 3

/** mux frame header: streamId(u32) + kind(u8) + len(u16) + rsv(u8). */
export const FRAME_HEAD = 8
/** Largest mux payload, matching the proxy. */
export const MAX_PAYLOAD = 16384
/** Per-stream receive window. */
export const WINDOW = 256 * 1024

/** Keepalive cadence on streamId 0, and the silence that ends a link. */
export const KEEPALIVE_MS = 30_000
export const LINK_IDLE_MS = 90_000

/** Largest plaintext carried by one Noise transport message. */
export const MAX_NOISE_PLAINTEXT = 65_519
