import { Schema as S } from 'effect'

export type AndroidDispatchDecision =
  | { readonly _tag: 'Skip' }
  | { readonly _tag: 'PlayIntegrity' }
  | { readonly _tag: 'KeyAttestation' }
  | { readonly _tag: 'Voucher' }
  | { readonly _tag: 'MissingAttestationType' }
  | { readonly _tag: 'UnknownAttestationType' }

/** Attestation types the dispatch recognizes. Anything else yields `UnknownAttestationType`. */
export const KNOWN_ATTESTATION_TYPES = ['play-integrity', 'key-attestation', 'voucher'] as const

export const AndroidDispatchInput = S.Struct({
  iosPackage: S.UndefinedOr(S.String),
  androidPackage: S.UndefinedOr(S.String),
  attestationToken: S.UndefinedOr(S.String),
  attestationType: S.UndefinedOr(S.String),
})
export type AndroidDispatchInput = S.Schema.Type<typeof AndroidDispatchInput>

const KEY_ATTESTATION = 'key-attestation' as const
const VOUCHER = 'voucher' as const
const PLAY_INTEGRITY = 'play-integrity' as const

export const decideAndroidDispatch = (input: AndroidDispatchInput): AndroidDispatchDecision => {
  if (input.iosPackage !== undefined) {
    return { _tag: 'Skip' }
  }

  if (input.attestationType === KEY_ATTESTATION) {
    return { _tag: 'KeyAttestation' }
  }

  if (input.attestationType === VOUCHER) {
    return { _tag: 'Voucher' }
  }

  if (
    input.androidPackage === undefined &&
    input.attestationToken === undefined
  ) {
    return { _tag: 'Skip' }
  }

  if (input.attestationType === undefined) {
    return { _tag: 'MissingAttestationType' }
  }

  if (input.attestationType === PLAY_INTEGRITY) {
    return { _tag: 'PlayIntegrity' }
  }

  return { _tag: 'UnknownAttestationType' }
}
