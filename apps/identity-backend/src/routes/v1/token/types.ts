import { z } from '@hono/zod-openapi'
import { decodeBase64 } from '@std/encoding'

export const TokenRequestHeaders = z
  .object({
    'Auth-ClientId': z.string().base64().max(64).openapi({
      description:
        'SR25519 public key of the client (base64-encoded, 32 bytes). The corresponding private key signs the proof payload.',
      example: 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
    }),
    'Auth-ClientProof': z.string().min(1).max(128).openapi({
      description:
        'SR25519 signature over the proof payload (base64-encoded, 64 bytes). The proof payload is SHA-256(challenge || clientId || SHA-256(requestBody)).',
      example: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    }),
    'Auth-Challenge': z.string().min(1).max(256).openapi({
      description:
        'Server-issued challenge (base64-encoded). The client includes this in the proof payload to prevent replay attacks.',
      example: 'ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=',
    }),
    'Auth-Payload': z.optional(z.string().max(16384)).openapi({
      description:
        'Platform attestation proof (base64-encoded). iOS: Apple App Attest assertion. Android: Google Play Integrity token. Required when platform attestation is enforced (ENFORCE_AUTH=true); omit when attestation is disabled.',
      example: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    }),
    'Auth-iOS-KeyId': z.optional(z.string().max(64)).openapi({
      description:
        'Apple App Attest key identifier (base64-encoded). Required for iOS clients when platform attestation is enforced; must be absent for Android.',
      example: 'ASNFZ4mrze8BI0VniavN7w==',
    }),
    'Auth-iOS-Package': z.optional(z.string()).openapi({
      description:
        'iOS bundle identifier. Required for iOS clients when platform attestation is enforced; must be absent for Android.',
      example: 'io.example.app',
    }),
    'Auth-Android-Package': z.optional(z.string()).openapi({
      description:
        'Android package name. Required for Android Play Integrity clients when platform attestation is enforced; must be absent for iOS and key-attestation.',
      example: 'com.example.app',
    }),
    'Auth-Attestation-Type': z.optional(z.enum(['play-integrity', 'key-attestation', 'voucher'])).openapi({
      description:
        "Android attestation dispatch header. Conditionally required: must be present when Auth-Android-Package or attestationChain body is provided. Use 'play-integrity' with Auth-Android-Package and Auth-Payload; use 'key-attestation' with attestationChain in the request body; use 'voucher' with Auth-Voucher-Secret. Ignored for iOS.",
      example: 'key-attestation',
    }),
    'Auth-Voucher-Secret': z.optional(z.string().max(64)).openapi({
      description:
        'Voucher secret scanned from a paper QR (base64-encoded, 32 bytes). Required when Auth-Attestation-Type is voucher. Single-use.',
      example: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    }),
  })
  .refine(
    (h) => !(h['Auth-iOS-Package'] && h['Auth-Android-Package']),
    {
      message: 'Cannot provide both iOS and Android package headers',
      path: ['Auth-iOS-Package'],
    },
  )
  .transform((h) => ({
    clientId: decodeBase64(h['Auth-ClientId']),
    clientProof: decodeBase64(h['Auth-ClientProof']),
    challenge: decodeBase64(h['Auth-Challenge']),
    iosPackage: h['Auth-iOS-Package'],
    authAttestationType: h['Auth-Attestation-Type'],
    voucherSecret: h['Auth-Voucher-Secret'],
  }))
  .openapi({ title: 'TokenRequestHeaders' })

export const TokenRequest = z.object({
  attestationChain: z.optional(z.array(z.base64().max(8192)).min(2).max(10)).openapi({
    description: 'Android Keystore certificate chain — each element is a Base64-encoded DER certificate. ' +
      'Leaf cert first, then intermediates ending at a cert chained to Google root CA. ' +
      'Required when Auth-Attestation-Type is key-attestation.',
    example: ['MIIG...', 'MIIF...'],
  }),
}).openapi({
  title: 'TokenRequest',
  description: 'Authentication via SR25519 client proof. Include attestationChain when using Android Key Attestation.',
})

/**
 * Emitted by the auth plugin before any verifier runs when an Android request
 * fails to declare a valid `Auth-Attestation-Type`. iOS requests never produce
 * this response.
 */
export const AttestationDispatchError = z
  .object({
    _tag: z.enum(['MissingAttestationTypeHeader', 'UnknownAttestationType']).openapi({
      description:
        'MissingAttestationTypeHeader: an Android request omitted Auth-Attestation-Type. UnknownAttestationType: the value was not one of play-integrity, key-attestation, voucher.',
    }),
    error: z.string().openapi({
      description: 'Human-readable explanation of the dispatch failure.',
    }),
  })
  .openapi({ title: 'AttestationDispatchError' })

export const TokenResponse = z
  .object({
    token: z.string().openapi({
      description:
        'JWT access token. HS256-signed with `polkadot-app` issuer, 24-hour TTL. Pass as `Authorization: Bearer {token}` on subsequent requests. Decoded payload contains `sub` (sr25519 client public key, hex-encoded, 64 chars plus `0x` prefix), `iss`, `iat`, `exp`, and platform claims when available: `plt` (`ios` or `android`) and `appFromOfficialStore`.',
      example:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwb2xrYWRvdC1hcHAiLCJzdWIiOiIweGQ0MzU5M2M3MTVmZGQzMWM2MTE0MWFiZDA0YTk5ZmQ2ODIyYzg1NTg4NTRjY2RlMzlhNTY4NGU3YTU2ZGEyN2QiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.xxx',
    }),
    refreshToken: z.string().openapi({
      description:
        'Opaque refresh token. 256-bit cryptographically random value, base64-encoded (44 characters). Sliding 30-day expiry — each successful rotation resets the clock. **Secret**: never log, store in localStorage, or expose to third parties.',
      example: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    }),
  })
  .openapi({
    title: 'TokenResponse',
    description:
      'Token pair for silent session renewal. Use the `token` for API authorization. Use the `refreshToken` with `POST /v1/token/refresh` before the access token expires to obtain a fresh pair without re-attestation.',
    example: {
      token:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwb2xrYWRvdC1hcHAiLCJzdWIiOiIweGQ0MzU5M2M3MTVmZGQzMWM2MTE0MWFiZDA0YTk5ZmQ2ODIyYzg1NTg4NTRjY2RlMzlhNTY4NGU3YTU2ZGEyN2QiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.xxx',
      refreshToken: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    },
  })

export const RefreshTokenRequest = z
  .object({
    refreshToken: z.string().base64().max(128).openapi({
      description:
        'Opaque refresh token previously issued by `POST /consumer_registrationtoken` or a prior `POST /v1/token/refresh`. Must be exactly 44 base64 characters. Each token is single-use — after rotation, the submitted token is permanently revoked.',
      example: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    }),
  })
  .openapi({
    title: 'RefreshTokenRequest',
    description:
      'Rotate a refresh token. The submitted token is permanently revoked and a new token pair is issued. This is not idempotent — each call consumes the submitted token.',
    example: {
      refreshToken: 'obLD1OG/RrOWYNaGvNfIraXKzGVY01SyiaSKsAl0qAY=',
    },
  })

export const RefreshTokenResponse = z
  .object({
    token: z.string().openapi({
      description:
        'New JWT access token with the same `sub` claim (sr25519 client public key in hex format) as the original. The previous access token remains valid until its natural expiry — there is no token revocation on rotation.',
      example:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwb2xrYWRvdC1hcHAiLCJzdWIiOiIweGQ0MzU5M2M3MTVmZGQzMWM2MTE0MWFiZDA0YTk5ZmQ2ODIyYzg1NTg4NTRjY2RlMzlhNTY4NGU3YTU2ZGEyN2QiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.yyy',
    }),
    refreshToken: z.string().openapi({
      description:
        'New opaque refresh token. **The submitted token is now revoked** — persist this replacement immediately. If this token is lost, the user must re-authenticate via platform attestation.',
      example: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
    }),
  })
  .openapi({
    title: 'RefreshTokenResponse',
    description:
      'Rotated token pair. The new `token` replaces the previous access token for API calls. The new `refreshToken` replaces the submitted token for future rotations.',
    example: {
      token:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwb2xrYWRvdC1hcHAiLCJzdWIiOiIweGQ0MzU5M2M3MTVmZGQzMWM2MTE0MWFiZDA0YTk5ZmQ2ODIyYzg1NTg4NTRjY2RlMzlhNTY4NGU3YTU2ZGEyN2QiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.yyy',
      refreshToken: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
    },
  })
