/**
 * Durable identity and the paired-device whitelist, both in `ctx.credentials`.
 *
 * The bridge key survives restarts and reinstalls, so a phone's QR code stays
 * valid until the Mac itself changes. Pairing tokens do not survive: they are
 * one-shot, five-minute, memory-only.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { generateKeyPair, publicKeyOf, type KeyPair } from './noise.ts'

const IDENTITY_KEY = 'mobile-bridge/identity' as CredentialKey
const DEVICES_KEY = 'mobile-bridge/devices' as CredentialKey

/** Pairing tokens are single-use and short-lived by design. */
const PAIRING_TTL_MS = 5 * 60 * 1000
/** Do not rewrite the store for every request; lastSeen is a coarse fact. */
const TOUCH_INTERVAL_MS = 60 * 1000

/** One paired phone. */
export interface DeviceRecord {
  /** base64url X25519 public key — the device's whole identity. */
  deviceId: string
  label: string
  addedAt: number
  lastSeenAt: number
  expiresAt: number
}

/** Base64url without padding, the form used in QR codes and JSON. */
export function encodeKey(key: Buffer): string {
  return key.toString('base64url')
}

/** Load the bridge's static key pair, creating it on first run. */
export async function loadIdentity(credentials: CredentialProvider): Promise<KeyPair> {
  let stored: string | undefined
  const record = await credentials.modifyRecord(IDENTITY_KEY, async (current) => {
    if (current?.kind === 'grant') {
      const payload = current.payload as { privateKey?: unknown }
      if (typeof payload.privateKey === 'string') {
        stored = payload.privateKey
        return undefined
      }
    }
    stored = generateKeyPair().privateKey.toString('base64')
    return { kind: 'grant', payload: { privateKey: stored } }
  })
  if (stored === undefined && record?.kind === 'grant') {
    stored = (record.payload as { privateKey: string }).privateKey
  }
  if (stored === undefined) throw new Error('mobile-bridge: identity could not be stored')
  const privateKey = Buffer.from(stored, 'base64')
  return { privateKey, publicKey: publicKeyOf(privateKey) }
}

/** The paired-device whitelist: the only thing that admits a phone. */
export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly pairings = new Map<string, number>()
  private lastWrite = 0

  private constructor(
    private readonly credentials: CredentialProvider,
    private readonly ttlDays: number,
  ) {}

  /** Read the stored whitelist. */
  static async load(credentials: CredentialProvider, ttlDays: number): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(credentials, ttlDays)
    const record = await credentials.readRecord(DEVICES_KEY)
    if (record?.kind === 'grant') {
      const payload = record.payload as { devices?: DeviceRecord[] }
      for (const device of payload.devices ?? []) registry.devices.set(device.deviceId, device)
    }
    return registry
  }

  /** Every paired device, newest first. */
  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => b.addedAt - a.addedAt)
  }

  /** Mint a one-shot pairing token for a QR code. */
  createPairing(): { token: string, expiresAt: number } {
    const now = Date.now()
    for (const [token, expiresAt] of this.pairings) {
      if (expiresAt <= now) this.pairings.delete(token)
    }
    const token = randomBytes(32)
    const expiresAt = now + PAIRING_TTL_MS
    this.pairings.set(token.toString('base64url'), expiresAt)
    return { token: token.toString('base64url'), expiresAt }
  }

  /**
   * Decide whether one handshaked device may be served.
   * @param deviceKey - the device's static public key from the Noise handshake.
   * @param pairingToken - the first-message payload, when the device is new.
   */
  async authorize(deviceKey: Buffer, pairingToken: Buffer): Promise<boolean> {
    const deviceId = encodeKey(deviceKey)
    const now = Date.now()
    const known = this.devices.get(deviceId)
    if (known !== undefined && known.expiresAt > now) {
      if (now - this.lastWrite > TOUCH_INTERVAL_MS) {
        known.lastSeenAt = now
        await this.save()
      }
      return true
    }
    if (!this.consume(pairingToken, now)) return false
    this.devices.set(deviceId, {
      deviceId,
      label: `iPhone ${deviceId.slice(0, 6)}`,
      addedAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlDays * 24 * 60 * 60 * 1000,
    })
    await this.save()
    return true
  }

  /** Revoke one device; its next handshake fails. */
  async revoke(deviceId: string): Promise<boolean> {
    if (!this.devices.delete(deviceId)) return false
    await this.save()
    return true
  }

  private consume(pairingToken: Buffer, now: number): boolean {
    if (pairingToken.length !== 32) return false
    for (const [token, expiresAt] of this.pairings) {
      const candidate = Buffer.from(token, 'base64url')
      if (candidate.length !== pairingToken.length) continue
      if (!timingSafeEqual(candidate, pairingToken)) continue
      this.pairings.delete(token)
      return expiresAt > now
    }
    return false
  }

  private async save(): Promise<void> {
    this.lastWrite = Date.now()
    const devices = this.list()
    await this.credentials.modifyRecord(DEVICES_KEY, async () => ({ kind: 'grant', payload: { devices } }))
  }
}
