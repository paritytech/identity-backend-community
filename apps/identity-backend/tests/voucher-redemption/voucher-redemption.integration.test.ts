import { ProblemDetailZod } from '#root/lib/problem-details.js'
import { TokenResponse } from '#root/routes/v1/token/types.js'
import { And, Given, Then, When } from '@identity-backend/effect-vitest-gherkin'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  cleanUpVouchers,
  makeVoucher,
  presentVoucher,
  presentVoucherWithoutSecret,
  redeemedAt,
  responseJson,
  seedVoucher,
} from './fixtures/voucher-client.js'
import { feature, sharedFileLayer } from './layers.js'

feature('Voucher Redemption')
  .withLayer(sharedFileLayer)
  .withScope({})
  .body(({ background, scenario, scope }) => {
    background(
      Effect.gen(function*() {
        yield* cleanUpVouchers
      }),
    )

    scenario(
      'A holder redeems a registered voucher',
      scope.pipe(
        Given('a printed voucher has been registered')(
          'voucher',
          () =>
            Effect.gen(function*() {
              const voucher = makeVoucher()
              yield* seedVoucher(voucher.secretHash)
              return voucher
            }),
        ),
        When('the holder presents the voucher with a valid client proof')(
          'res',
          ({ voucher }) => presentVoucher({ secret: voucher.secretB64 }),
        ),
        Then('the holder receives an access token')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(200)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(TokenResponse))
            }),
        ),
        And('the voucher is marked redeemed')(
          ({ voucher }) =>
            Effect.gen(function*() {
              expect(yield* redeemedAt(voucher.secretHash)).not.toBeNull()
            }),
        ),
      ),
    )

    scenario(
      'A voucher cannot be redeemed a second time',
      scope.pipe(
        Given('a voucher that has already been redeemed once')(
          'voucher',
          () =>
            Effect.gen(function*() {
              const voucher = makeVoucher()
              yield* seedVoucher(voucher.secretHash)
              const first = yield* presentVoucher({ secret: voucher.secretB64 })
              expect(first.status).toBe(200)
              return voucher
            }),
        ),
        When('a second holder presents the same voucher')(
          'res',
          ({ voucher }) => presentVoucher({ secret: voucher.secretB64 }),
        ),
        Then('the second holder is told the voucher was already redeemed')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(409)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(ProblemDetailZod))
            }),
        ),
      ),
    )

    scenario(
      'An unregistered voucher is rejected as invalid',
      scope.pipe(
        Given('a voucher whose hash was never registered')(
          'voucher',
          () => Effect.succeed(makeVoucher()),
        ),
        When('the holder presents the unregistered voucher')(
          'res',
          ({ voucher }) => presentVoucher({ secret: voucher.secretB64 }),
        ),
        Then('the holder is told the voucher is invalid')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(401)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(ProblemDetailZod))
            }),
        ),
      ),
    )

    scenario(
      'A malformed voucher secret is rejected as invalid',
      scope.pipe(
        Given('a voucher secret that is not valid base64')(
          'secret',
          () => Effect.succeed('not valid base64 !!!'),
        ),
        When('the holder presents the malformed secret')(
          'res',
          ({ secret }) => presentVoucher({ secret }),
        ),
        Then('the holder is told the voucher is invalid')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(401)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(ProblemDetailZod))
            }),
        ),
      ),
    )

    scenario(
      'A voucher request without the secret header is rejected',
      scope.pipe(
        Given('a voucher request that omits the secret header')(() => Effect.void),
        When('the holder sends the request without a voucher secret')(
          'res',
          () => presentVoucherWithoutSecret,
        ),
        Then('the holder is told the voucher secret is required')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(400)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(ProblemDetailZod))
            }),
        ),
      ),
    )

    scenario(
      'An invalid client proof never burns the voucher',
      scope.pipe(
        Given('a registered voucher')(
          'voucher',
          () =>
            Effect.gen(function*() {
              const voucher = makeVoucher()
              yield* seedVoucher(voucher.secretHash)
              return voucher
            }),
        ),
        When('the holder presents the voucher with an invalid client proof')(
          'res',
          ({ voucher }) => presentVoucher({ secret: voucher.secretB64, tamperProof: true }),
        ),
        Then('the holder is told the client proof failed')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(401)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(ProblemDetailZod))
            }),
        ),
        And('the voucher is still redeemable with a valid proof')(
          ({ voucher }) =>
            Effect.gen(function*() {
              expect(yield* redeemedAt(voucher.secretHash)).toBeNull()
              const retry = yield* presentVoucher({ secret: voucher.secretB64 })
              expect(retry.status).toBe(200)
              expect(yield* redeemedAt(voucher.secretHash)).not.toBeNull()
            }),
        ),
      ),
    )

    scenario(
      'Two holders racing for one voucher produce a single winner',
      scope.pipe(
        Given('a registered voucher')(
          'voucher',
          () =>
            Effect.gen(function*() {
              const voucher = makeVoucher()
              yield* seedVoucher(voucher.secretHash)
              return voucher
            }),
        ),
        When('two holders present the same voucher at the same time')(
          'results',
          ({ voucher }) =>
            Effect.all(
              [presentVoucher({ secret: voucher.secretB64 }), presentVoucher({ secret: voucher.secretB64 })],
              { concurrency: 2 },
            ),
        ),
        Then('exactly one is granted a token and the other is told it was already redeemed')(
          ({ results }) =>
            Effect.sync(() => {
              const statuses = results.map((r) => r.status).sort((a, b) => a - b)
              expect(statuses).toEqual([200, 409])
            }),
        ),
      ),
    )

    scenario(
      'A voucher presented with an Android package header still redeems',
      scope.pipe(
        Given('a registered voucher and a client declaring its Android package')(
          'voucher',
          () =>
            Effect.gen(function*() {
              const voucher = makeVoucher()
              yield* seedVoucher(voucher.secretHash)
              return voucher
            }),
        ),
        When('the holder presents the voucher alongside Auth-Android-Package')(
          'res',
          ({ voucher }) => presentVoucher({ secret: voucher.secretB64, androidPackage: 'io.parity.polkadotwallet' }),
        ),
        Then('the holder receives an access token')(
          ({ res }) =>
            Effect.gen(function*() {
              expect(res.status).toBe(200)
              const json = yield* responseJson(res)
              expect(json).toEqual(expect.schemaMatching(TokenResponse))
            }),
        ),
        And('the voucher is marked redeemed')(
          ({ voucher }) =>
            Effect.gen(function*() {
              expect(yield* redeemedAt(voucher.secretHash)).not.toBeNull()
            }),
        ),
      ),
    )
  })
