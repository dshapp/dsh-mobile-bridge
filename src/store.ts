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
/** Ceiling on a display label, so one rename cannot bloat the whitelist file. */
const MAX_LABEL_LENGTH = 64

/** A one-shot pairing code and the moment it stops working. */
export interface Pairing {
  token: string
  expiresAt: number
}

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
  /**
   * How to hang up on each device, keyed by device id — the difference between
   * "paired" and "here", and the only way a revocation can affect a connection
   * that was already admitted.
   */
  private readonly live = new Map<string, Set<() => void>>()
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

  /**
   * Mint a one-shot pairing token for a QR code, replacing any unused one.
   *
   * Exactly one code is live at a time, so what a screen shows is what a phone
   * can redeem — an abandoned code cannot come back to life days later.
   */
  createPairing(): Pairing {
    this.pairings.clear()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairings.set(token, expiresAt)
    return { token, expiresAt }
  }

  /**
   * The code a screen should be showing, or null when there is none.
   *
   * Redeeming or expiring removes it, which is how a client learns — without
   * a timer of its own — that the phone got in or that the code went stale.
   */
  activePairing(): Pairing | null {
    const now = Date.now()
    for (const [token, expiresAt] of this.pairings) {
      if (expiresAt <= now) this.pairings.delete(token)
      else return { token, expiresAt }
    }
    return null
  }

  /**
   * Decide whether one handshaked device may be served.
   * @param deviceKey - the device's static public key from the Noise handshake.
   * @param pairingToken - the first-message payload, when the device is new.
   * @returns the device id when it may be served, or null when it may not.
   */
  async authorize(deviceKey: Buffer, pairingToken: Buffer): Promise<string | null> {
    const deviceId = encodeKey(deviceKey)
    const now = Date.now()
    // A device that expired while still connected keeps its session until
    // something notices; noticing here costs one pass over the whitelist.
    await this.expire(now)
    const known = this.devices.get(deviceId)
    if (known !== undefined && known.expiresAt > now) {
      if (now - this.lastWrite > TOUCH_INTERVAL_MS) {
        known.lastSeenAt = now
        await this.save()
      }
      return deviceId
    }
    if (!this.consume(pairingToken, now)) return null
    // A device re-pairing under a key that already has connections (it
    // expired, then paired again) must not keep the old ones alive.
    this.disconnect(deviceId)
    this.devices.set(deviceId, {
      deviceId,
      label: `iPhone ${deviceId.slice(0, 6)}`,
      addedAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlDays * 24 * 60 * 60 * 1000,
    })
    await this.save()
    return deviceId
  }

  /**
   * Register one live connection from a device.
   *
   * A phone opens a stream per HTTP connection, so presence is a set, not a
   * flag: the device is here until the last of its connections goes away. The
   * `dispose` callback is also kept as the handle {@link revoke} uses to hang
   * up on a device that is already admitted.
   * @param deviceId - the connecting device.
   * @param dispose - how to end this connection.
   * @returns a release callback, safe to call more than once.
   */
  attach(deviceId: string, dispose: () => void): () => void {
    const connections = this.live.get(deviceId)
    if (connections === undefined) this.live.set(deviceId, new Set([dispose]))
    else connections.add(dispose)
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.live.get(deviceId)
      if (current === undefined) return
      current.delete(dispose)
      if (current.size > 0) return
      this.live.delete(deviceId)
      // The moment it left is the "last seen" a person actually cares about.
      const record = this.devices.get(deviceId)
      if (record === undefined) return
      record.lastSeenAt = Date.now()
      if (Date.now() - this.lastWrite > TOUCH_INTERVAL_MS) void this.save().catch(() => {})
    }
  }

  /** Whether this device has a connection open right now. */
  isOnline(deviceId: string): boolean {
    return this.live.has(deviceId)
  }

  /**
   * Revoke one device: it is removed from the whitelist, and every connection
   * it already holds is hung up.
   *
   * Removing the record alone would leave a revoked phone with full access for
   * as long as it kept one socket open, which is indefinitely for HTTP.
   */
  async revoke(deviceId: string): Promise<boolean> {
    if (!this.devices.delete(deviceId)) return false
    this.disconnect(deviceId)
    await this.save()
    return true
  }

  /**
   * Set the display label of one paired device.
   *
   * The label is presentation only: it is what a management screen shows, and
   * nothing in authorization reads it. A blank one is refused rather than
   * stored, so the whitelist never carries a nameless row.
   * @param deviceId - the device to relabel.
   * @param label - the new name; trimmed, and capped at {@link MAX_LABEL_LENGTH}.
   * @returns whether a device with that id was relabelled.
   */
  async rename(deviceId: string, label: string): Promise<boolean> {
    const record = this.devices.get(deviceId)
    const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH)
    if (record === undefined || trimmed === '') return false
    if (trimmed === record.label) return true
    record.label = trimmed
    await this.save()
    return true
  }

  /**
   * Hang up on every connection a device holds, without unwhitelisting it.
   *
   * One failing `dispose` must not strand the rest, so each is isolated.
   * @param deviceId - the device whose connections should end.
   */
  private disconnect(deviceId: string): void {
    const connections = this.live.get(deviceId)
    if (connections === undefined) return
    this.live.delete(deviceId)
    for (const dispose of connections) {
      try {
        dispose()
      } catch {
        // A connection that cannot be closed is already gone in every way
        // that matters; the rest still deserve their turn.
      }
    }
  }

  /** Drop and disconnect every device whose TTL has passed. */
  private async expire(now: number): Promise<void> {
    let changed = false
    for (const [deviceId, record] of this.devices) {
      if (record.expiresAt > now) continue
      this.devices.delete(deviceId)
      this.disconnect(deviceId)
      changed = true
    }
    if (changed) await this.save()
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
