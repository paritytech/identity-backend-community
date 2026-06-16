import { describe, it } from '@effect/vitest'
import { Arbitrary, Schema as S } from 'effect'
import { AndroidDispatchInput, decideAndroidDispatch, KNOWN_ATTESTATION_TYPES } from '../dispatch.js'

// Refined Schema: attestationType that is NOT one of the known types. The refinement
// declares the type constraint; the annotated arbitrary generates constructively
// (prefix guarantees non-collision, no .filter rejection trap).
const UnknownAttestationType = S.String.pipe(
  S.filter((value): value is string => !(KNOWN_ATTESTATION_TYPES as ReadonlyArray<string>).includes(value)),
  S.annotations({
    arbitrary: () => (fcApi) => fcApi.string().map((s) => `unknown-${s}`),
  }),
)

const AndroidDispatchInputArb = Arbitrary.make(AndroidDispatchInput)
const UnknownAttestationTypeArb = Arbitrary.make(UnknownAttestationType)

describe('decideAndroidDispatch', () => {
  it.prop(
    '∀Headers_IosPackagePresent_=Skip',
    [AndroidDispatchInputArb],
    ([input]) => decideAndroidDispatch({ ...input, iosPackage: 'com.example.ios' })._tag === 'Skip',
  )

  it.prop(
    '∀Headers_KeyAttestationTypeNonIos_=KeyAttestation',
    [AndroidDispatchInputArb],
    ([input]) =>
      decideAndroidDispatch({ ...input, iosPackage: undefined, attestationType: 'key-attestation' })._tag ===
        'KeyAttestation',
  )

  it.prop(
    '∀Headers_VoucherTypeNonIos_=Voucher',
    [AndroidDispatchInputArb],
    ([input]) =>
      decideAndroidDispatch({ ...input, iosPackage: undefined, attestationType: 'voucher' })._tag ===
        'Voucher',
  )

  it.prop(
    '∀Headers_NoAndroidSignalsNonKeyAttestationOrVoucher_=Skip',
    [AndroidDispatchInputArb],
    ([input]) => {
      if (input.attestationType === 'key-attestation' || input.attestationType === 'voucher') return true
      return decideAndroidDispatch({
        iosPackage: undefined,
        androidPackage: undefined,
        attestationToken: undefined,
        attestationType: input.attestationType,
      })._tag === 'Skip'
    },
  )

  it.prop(
    '∀Headers_AndroidSignalNoType_=MissingType',
    [AndroidDispatchInputArb],
    ([input]) =>
      decideAndroidDispatch({
        iosPackage: undefined,
        androidPackage: input.androidPackage ?? 'com.example.app',
        attestationToken: input.attestationToken ?? 'some-token',
        attestationType: undefined,
      })._tag === 'MissingAttestationType',
  )

  it.prop(
    '∀Headers_AndroidSignalPlayIntegrity_=PlayIntegrity',
    [AndroidDispatchInputArb],
    ([input]) =>
      decideAndroidDispatch({
        iosPackage: undefined,
        androidPackage: input.androidPackage ?? 'com.example.app',
        attestationToken: input.attestationToken ?? 'some-token',
        attestationType: 'play-integrity',
      })._tag === 'PlayIntegrity',
  )

  it.prop(
    '∀Headers_AndroidSignalUnknownType_=UnknownType',
    [AndroidDispatchInputArb, UnknownAttestationTypeArb],
    ([input, type]) =>
      decideAndroidDispatch({
        iosPackage: undefined,
        androidPackage: input.androidPackage ?? 'com.example.app',
        attestationToken: input.attestationToken ?? 'some-token',
        attestationType: type,
      })._tag === 'UnknownAttestationType',
  )
})
