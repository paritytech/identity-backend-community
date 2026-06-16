import { DB } from '#root/db/drizzle.js'
import * as schema from '#root/db/schema.js'
import { AuthService } from '@identity-backend/auth/services'
import { sr25519 } from '@identity-backend/crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeBase64 } from '@std/encoding'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { createTokenClient } from '../../helpers/refresh-token-test-layer.js'

export interface Voucher {
  readonly secretB64: string
  readonly secretHash: string
}

/** Mints a voucher the way the provisioning script does: 32 random bytes, the
 * base64 secret for the QR, the SHA-256 hash for the row. */
export const makeVoucher = (): Voucher => {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32))
  return { secretB64: encodeBase64(secretBytes), secretHash: bytesToHex(sha256(secretBytes)) }
}

/** Wipes the voucher and refresh-token tables between scenarios. */
export const cleanUpVouchers = Effect.andThen(DB, (db) =>
  Effect.promise(async () => {
    await db.delete(schema.voucherSecrets).execute()
    await db.delete(schema.refreshTokens).execute()
  })).pipe(Effect.orDie)

/** Registers a voucher's hash — the only thing the backend ever stores. */
export const seedVoucher = (secretHash: string) =>
  Effect.andThen(DB, (db) => Effect.promise(() => db.insert(schema.voucherSecrets).values({ secretHash }).execute()))

/** Reads a response body as `unknown` — the typed hono client narrows `.json()`
 * to a per-status union of promises, which the body schema assertions decode
 * anyway. This keeps `Effect.promise` from over-inferring the success branch. */
export const responseJson = (res: { readonly json: () => Promise<unknown> }): Effect.Effect<unknown> =>
  Effect.promise(() => res.json())

/** Reads back the `redeemed_at` timestamp (null until the voucher is burned). */
export const redeemedAt = (secretHash: string) =>
  Effect.andThen(
    DB,
    (db) =>
      Effect.promise(() =>
        db.select().from(schema.voucherSecrets).where(eq(schema.voucherSecrets.secretHash, secretHash)).execute()
      ),
  ).pipe(Effect.map((rows) => rows[0]?.redeemedAt ?? null))

/** Presents a voucher to `POST /token`. Generates a fresh keypair + challenge
 * per call; `tamperProof` swaps in a random (invalid) signature. */
export const presentVoucher = (params: {
  readonly secret: string
  readonly tamperProof?: boolean
  readonly androidPackage?: string
}) =>
  Effect.gen(function*() {
    const authService = yield* AuthService
    const keypair = yield* sr25519.generateKeypair()
    const challenge = crypto.getRandomValues(new Uint8Array(24))
    const bodyBytes = new TextEncoder().encode('{}')
    const proofPayload = yield* authService.buildClientDataHash({
      payload: bodyBytes,
      challenge,
      clientId: keypair.publicKey,
    })
    const clientProof = params.tamperProof === true
      ? crypto.getRandomValues(new Uint8Array(64))
      : yield* keypair.sign(proofPayload)

    const tokenClient = yield* createTokenClient
    return yield* Effect.promise(() =>
      tokenClient.index.$post({
        header: {
          'Auth-ClientId': encodeBase64(keypair.publicKey),
          'Auth-ClientProof': encodeBase64(clientProof),
          'Auth-Challenge': encodeBase64(challenge),
          'Auth-Attestation-Type': 'voucher',
          'Auth-Voucher-Secret': params.secret,
          ...(params.androidPackage !== undefined
            ? { 'Auth-Android-Package': params.androidPackage }
            : {}),
        },
        json: {},
      })
    )
  })

/** Presents a `voucher` request that omits the `Auth-Voucher-Secret` header. */
export const presentVoucherWithoutSecret = Effect.gen(function*() {
  const authService = yield* AuthService
  const keypair = yield* sr25519.generateKeypair()
  const challenge = crypto.getRandomValues(new Uint8Array(24))
  const bodyBytes = new TextEncoder().encode('{}')
  const proofPayload = yield* authService.buildClientDataHash({
    payload: bodyBytes,
    challenge,
    clientId: keypair.publicKey,
  })
  const clientProof = yield* keypair.sign(proofPayload)

  const tokenClient = yield* createTokenClient
  return yield* Effect.promise(() =>
    tokenClient.index.$post({
      header: {
        'Auth-ClientId': encodeBase64(keypair.publicKey),
        'Auth-ClientProof': encodeBase64(clientProof),
        'Auth-Challenge': encodeBase64(challenge),
        'Auth-Attestation-Type': 'voucher',
      },
      json: {},
    })
  )
})
