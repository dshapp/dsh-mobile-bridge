/**
 * Noise_25519_ChaChaPoly_SHA256 — the IK and XX patterns, on node:crypto only.
 *
 * This is the whole security story of mobile access: IK authenticates the phone
 * (its static key is the device id) and the bridge (the phone knows our static
 * key in advance), XX proves bridge key possession to the proxy. No TLS, no
 * certificates, no bearer tokens.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'

/** X25519 key length, SHA-256 length, Poly1305 tag length. */
const DHLEN = 32
const TAGLEN = 16

/** Bytes the Poly1305 tag adds to every sealed message; sizes seal buffers. */
export const NOISE_TAG_LEN = TAGLEN

/** Reused AAD: Noise transport messages authenticate no associated data. */
const EMPTY = Buffer.alloc(0)

const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** A raw X25519 static key pair. */
export interface KeyPair {
  readonly privateKey: Buffer
  readonly publicKey: Buffer
  /**
   * node's own handles for the same keys. Handing a raw Buffer to
   * `diffieHellman` makes node rebuild and revalidate a KeyObject on every
   * call (~29us private, ~15us public, 73% of a DH); these carry the handles
   * wherever they are already at hand, and are memoised when they are not.
   */
  readonly privateKeyObject?: KeyObject
  readonly publicKeyObject?: KeyObject
}

/** Generate one X25519 static key pair. */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return {
    privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(16),
    publicKey: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(12),
    // Generation produced them already, so keeping them is free and spares
    // the two DHs that use this ephemeral a re-parse of it.
    privateKeyObject: privateKey,
    publicKeyObject: publicKey,
  }
}

/** Derive the public half of a raw private key. */
export function publicKeyOf(privateKey: Buffer): Buffer {
  const key = createPublicKey(rawPrivateKeyObject(privateKey))
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).subarray(12)
}

/** Parse one raw private key; DER framing is why callers cache the result. */
function rawPrivateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/** Parse one raw public key; DER framing is why callers cache the result. */
function rawPublicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** Private KeyObjects by pair, so a long-lived key is parsed once at most. */
const privateObjects = new WeakMap<KeyPair, KeyObject>()

function privateObject(keyPair: KeyPair): KeyObject {
  const cached = keyPair.privateKeyObject ?? privateObjects.get(keyPair)
  if (cached !== undefined) return cached
  const parsed = rawPrivateKeyObject(keyPair.privateKey)
  privateObjects.set(keyPair, parsed)
  return parsed
}

function dh(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  return diffieHellman({ privateKey, publicKey })
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/** Noise HKDF: two or three chained HMAC outputs. */
function hkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const temp = hmac(chainingKey, ikm)
  const first = hmac(temp, Buffer.from([1]))
  const second = hmac(temp, Buffer.concat([first, Buffer.from([2])]))
  if (outputs === 2) return [first, second]
  return [first, second, hmac(temp, Buffer.concat([second, Buffer.from([3])]))]
}

/** One directional ChaChaPoly key with its 64-bit nonce counter. */
class CipherState {
  private readonly key: KeyObject | undefined
  private nonce = 0n

  constructor(key?: Buffer) {
    // Handed a raw Buffer, node rebuilds and revalidates a KeyObject inside
    // every createCipheriv call: ~5.9us of the ~7.5us a message cost, and the
    // single largest consumer of this process's CPU under load. Building the
    // KeyObject once drops construction to ~0.6us.
    this.key = key === undefined ? undefined : createSecretKey(key)
  }

  get hasKey(): boolean {
    return this.key !== undefined
  }

  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (this.key === undefined) return plaintext
    const sealed = Buffer.allocUnsafe(plaintext.length + TAGLEN)
    this.sealInto(ad, plaintext, sealed, 0)
    return sealed
  }

  /** Seal `plaintext` into `out` at `offset`; returns the bytes written. */
  sealInto(ad: Buffer, plaintext: Buffer, out: Buffer, offset: number): number {
    if (this.key === undefined) {
      plaintext.copy(out, offset)
      return plaintext.length
    }
    const cipher = createCipheriv('chacha20-poly1305', this.key, this.iv(), { authTagLength: TAGLEN })
    cipher.setAAD(ad, { plaintextLength: plaintext.length })
    const body = cipher.update(plaintext)
    body.copy(out, offset)
    cipher.final()
    cipher.getAuthTag().copy(out, offset + body.length)
    return body.length + TAGLEN
  }

  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (this.key === undefined) return ciphertext
    if (ciphertext.length < TAGLEN) throw new Error('noise: truncated ciphertext')
    const body = ciphertext.subarray(0, ciphertext.length - TAGLEN)
    const decipher = createDecipheriv('chacha20-poly1305', this.key, this.iv(), { authTagLength: TAGLEN })
    decipher.setAAD(ad, { plaintextLength: body.length })
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN))
    const plaintext = Buffer.allocUnsafe(body.length)
    decipher.update(body).copy(plaintext, 0)
    decipher.final()
    return plaintext
  }

  private iv(): Buffer {
    const iv = Buffer.alloc(12)
    iv.writeBigUInt64LE(this.nonce, 4)
    this.nonce += 1n
    return iv
  }
}

/** Established Noise session: one cipher per direction. */
export class NoiseTransport {
  constructor(private readonly send: CipherState, private readonly receive: CipherState) {}

  encrypt(plaintext: Buffer): Buffer {
    return this.send.encrypt(EMPTY, plaintext)
  }

  /**
   * Seal `plaintext` straight into a caller-owned buffer at `offset`.
   * Returns the bytes written, so a framed writer can reserve its length
   * prefix up front rather than allocating and copying a sealed buffer.
   */
  sealInto(plaintext: Buffer, out: Buffer, offset: number): number {
    return this.send.sealInto(EMPTY, plaintext, out, offset)
  }

  decrypt(ciphertext: Buffer): Buffer {
    return this.receive.decrypt(EMPTY, ciphertext)
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss'

interface Pattern {
  /** Static keys known before the first message; only the responder's, here. */
  readonly responderPreShared: boolean
  readonly messages: readonly (readonly Token[])[]
}

const PATTERNS: Record<'XX' | 'IK', Pattern> = {
  XX: {
    responderPreShared: false,
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']],
  },
  IK: {
    responderPreShared: true,
    messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']],
  },
}

/** Options for one handshake run. */
export interface HandshakeOptions {
  readonly pattern: 'XX' | 'IK'
  readonly initiator: boolean
  readonly staticKey: KeyPair
  /** Required for an IK initiator: the responder's static public key. */
  readonly remoteStatic?: Buffer
  /** Bytes both sides mix in before message one; the 37-byte preamble here. */
  readonly prologue: Buffer
}

/** One Noise handshake, driven token by token. */
export class Handshake {
  private chainingKey: Buffer
  private hash: Buffer
  private cipher = new CipherState()
  private ephemeral: KeyPair | undefined
  private remoteEphemeral: Buffer | undefined
  private remoteEphemeralObject: KeyObject | undefined
  private remoteStaticKey: Buffer | undefined
  private remoteStaticObject: KeyObject | undefined
  private index = 0

  private readonly pattern: Pattern
  private readonly initiator: boolean
  private readonly staticKey: KeyPair

  constructor(options: HandshakeOptions) {
    this.pattern = PATTERNS[options.pattern]
    this.initiator = options.initiator
    this.staticKey = options.staticKey
    this.remoteStaticKey = options.remoteStatic

    const name = Buffer.from(`Noise_${options.pattern}_25519_ChaChaPoly_SHA256`, 'utf8')
    this.hash = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name)
    this.chainingKey = Buffer.from(this.hash)
    this.mixHash(options.prologue)
    if (this.pattern.responderPreShared) {
      const key = this.initiator ? this.remoteStaticKey : this.staticKey.publicKey
      if (key === undefined) throw new Error('noise: IK initiator needs the responder static key')
      this.mixHash(key)
    }
  }

  /** True once every pattern message has been written or read. */
  get complete(): boolean {
    return this.index >= this.pattern.messages.length
  }

  /** The peer's static public key, known once the pattern has carried it. */
  get remoteStatic(): Buffer | undefined {
    return this.remoteStaticKey
  }

  /** Whether the next message is ours to write. */
  get writeTurn(): boolean {
    return this.index % 2 === (this.initiator ? 0 : 1)
  }

  /** Write the next handshake message. */
  write(payload: Buffer = Buffer.alloc(0)): Buffer {
    const tokens = this.pattern.messages[this.index]
    if (tokens === undefined || !this.writeTurn) throw new Error('noise: unexpected write')
    const parts: Buffer[] = []
    for (const token of tokens) {
      if (token === 'e') {
        this.ephemeral = generateKeyPair()
        parts.push(this.ephemeral.publicKey)
        this.mixHash(this.ephemeral.publicKey)
      } else if (token === 's') {
        const encrypted = this.encryptAndHash(this.staticKey.publicKey)
        parts.push(encrypted)
      } else {
        this.mixKey(this.dhFor(token))
      }
    }
    parts.push(this.encryptAndHash(payload))
    this.index += 1
    return Buffer.concat(parts)
  }

  /** Read the next handshake message, returning its payload. */
  read(message: Buffer): Buffer {
    const tokens = this.pattern.messages[this.index]
    if (tokens === undefined || this.writeTurn) throw new Error('noise: unexpected read')
    let rest = message
    for (const token of tokens) {
      if (token === 'e') {
        if (rest.length < DHLEN) throw new Error('noise: truncated handshake message')
        this.remoteEphemeral = rest.subarray(0, DHLEN)
        this.remoteEphemeralObject = undefined
        this.mixHash(this.remoteEphemeral)
        rest = rest.subarray(DHLEN)
      } else if (token === 's') {
        const size = this.cipher.hasKey ? DHLEN + TAGLEN : DHLEN
        if (rest.length < size) throw new Error('noise: truncated handshake message')
        this.remoteStaticKey = this.decryptAndHash(rest.subarray(0, size))
        this.remoteStaticObject = undefined
        rest = rest.subarray(size)
      } else {
        this.mixKey(this.dhFor(token))
      }
    }
    const payload = this.decryptAndHash(rest)
    this.index += 1
    return payload
  }

  /** Derive the transport ciphers once the handshake is complete. */
  split(): NoiseTransport {
    if (!this.complete) throw new Error('noise: handshake is not complete')
    const [first, second] = hkdf(this.chainingKey, Buffer.alloc(0), 2) as [Buffer, Buffer]
    return this.initiator
      ? new NoiseTransport(new CipherState(first), new CipherState(second))
      : new NoiseTransport(new CipherState(second), new CipherState(first))
  }

  /** The peer's ephemeral public key as a KeyObject, parsed at most once. */
  private remoteEphemeralKey(): KeyObject | undefined {
    if (this.remoteEphemeral === undefined) return undefined
    this.remoteEphemeralObject ??= rawPublicKeyObject(this.remoteEphemeral)
    return this.remoteEphemeralObject
  }

  /** The peer's static public key as a KeyObject, parsed at most once. */
  private remoteStaticKeyObject(): KeyObject | undefined {
    if (this.remoteStaticKey === undefined) return undefined
    this.remoteStaticObject ??= rawPublicKeyObject(this.remoteStaticKey)
    return this.remoteStaticObject
  }

  private dhFor(token: Token): Buffer {
    const local = this.initiator
    const e = this.ephemeral
    // Each of these two handles is used by two tokens, so parsing it here
    // instead of inside dh() halves the DER work of a handshake.
    const re = this.remoteEphemeralKey()
    const rs = this.remoteStaticKeyObject()
    const missing = (): never => { throw new Error(`noise: token ${token} has no key material`) }
    switch (token) {
      case 'ee':
        return e && re ? dh(privateObject(e), re) : missing()
      case 'ss':
        return rs ? dh(privateObject(this.staticKey), rs) : missing()
      case 'es':
        // "es" is always initiator-ephemeral with responder-static.
        return local
          ? (e && rs ? dh(privateObject(e), rs) : missing())
          : (re ? dh(privateObject(this.staticKey), re) : missing())
      case 'se':
        // "se" is always initiator-static with responder-ephemeral.
        return local
          ? (re ? dh(privateObject(this.staticKey), re) : missing())
          : (e && rs ? dh(privateObject(e), rs) : missing())
      default:
        return missing()
    }
  }

  private mixHash(data: Buffer): void {
    this.hash = sha256(Buffer.concat([this.hash, data]))
  }

  private mixKey(ikm: Buffer): void {
    const [chainingKey, key] = hkdf(this.chainingKey, ikm, 2) as [Buffer, Buffer]
    this.chainingKey = chainingKey
    this.cipher = new CipherState(key)
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.cipher.encrypt(this.hash, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.cipher.decrypt(this.hash, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }
}
