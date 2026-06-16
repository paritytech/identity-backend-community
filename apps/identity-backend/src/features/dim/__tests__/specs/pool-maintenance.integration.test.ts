import { DB } from '#root/db/drizzle.js'
import { TicketPoolShell } from '#root/features/dim/invitation-ticket-pool.shell.js'
import { OnChainTicketAPIError } from '#root/features/dim/onchain-ticket.adapter.js'
import { expect } from '@effect/vitest'
import { And, Given, Then, When } from '@identity-backend/effect-vitest-gherkin'
import { Effect, HashMap } from 'effect'
import { BATCH_SIZE, DIM_GAME, DIM_PROOF_OF_INK, NETWORK_WESTEND2, POOL_TARGET } from '../helpers/constants.js'
import { cleanUp, countTickets, insertAvailableTicket } from '../helpers/db-helpers.js'
import { generateTestTicket } from '../helpers/factories.js'
import { FakeOnChainTicketAPI } from '../helpers/fakes/onchain-api.js'
import { feature, testLayer } from '../helpers/layers.js'

feature('Invitation Ticket Pool Maintenance')
  .withScenarioLayer(testLayer)
  .withScope({ db: DB, pool: TicketPoolShell, fake: FakeOnChainTicketAPI })
  .body(({ scenario, background, scope }) => {
    background(cleanUp)

    scenario(
      'Should_RefillAFullBatchInOneSubmission_When_PoolBelowTarget',
      scope.pipe(
        When('executing pool maintenance for Game')(({ pool }) => pool.execute(DIM_GAME, NETWORK_WESTEND2)),
        Then('a full batch is registered on-chain and persisted in a single submission')(({ db, fake }) =>
          Effect.gen(function*() {
            const submissions = yield* fake.getSubmissionCount
            const registered = yield* fake.getRegisteredTickets
            const persisted = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(submissions).toBe(1)
            expect(HashMap.size(registered)).toBe(BATCH_SIZE)
            expect(persisted).toBe(BATCH_SIZE)
          })
        ),
      ),
    )

    scenario(
      'Should_RegisterOnlySurvivors_When_PartOfTheBatchFails',
      scope.pipe(
        Given('two ticket registrations in the next batch will fail')(({ fake }) =>
          Effect.all([fake.setIndexWillFail(0), fake.setIndexWillFail(1)], { discard: true })
        ),
        When('executing pool maintenance for Game')(({ pool }) => pool.execute(DIM_GAME, NETWORK_WESTEND2)),
        Then('only the surviving tickets are registered and persisted, in one submission')(({ db, fake }) =>
          Effect.gen(function*() {
            const submissions = yield* fake.getSubmissionCount
            const registered = yield* fake.getRegisteredTickets
            const persisted = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(submissions).toBe(1)
            expect(HashMap.size(registered)).toBe(BATCH_SIZE - 2)
            expect(persisted).toBe(BATCH_SIZE - 2)
          })
        ),
      ),
    )

    scenario(
      'Should_ShrinkNextBatch_When_RegistrationIsResourceExhausted',
      scope.pipe(
        Given('the next on-chain submission fails with resource exhaustion')(({ fake }) =>
          fake.failNext(
            new OnChainTicketAPIError({ cause: { error: { type: 'Invalid', value: { type: 'ExhaustsResources' } } } }),
          )
        ),
        When('executing pool maintenance, then again after the failure clears')(({ pool }) =>
          Effect.gen(function*() {
            yield* pool.execute(DIM_GAME, NETWORK_WESTEND2)
            yield* pool.execute(DIM_GAME, NETWORK_WESTEND2)
          })
        ),
        Then('the recovery submission is half the size of the exhausted one')(({ fake }) =>
          Effect.gen(function*() {
            const sizes = yield* fake.getSubmittedBatchSizes
            expect(sizes).toEqual([BATCH_SIZE, BATCH_SIZE / 2])
          })
        ),
      ),
    )

    scenario(
      'Should_DoNothing_When_PoolAtTarget',
      scope.pipe(
        Given('pool has exactly POOL_TARGET tickets')('count', ({ db }) =>
          Effect.gen(function*() {
            for (let i = 0; i < POOL_TARGET; i++) {
              const ticket = yield* generateTestTicket
              yield* insertAvailableTicket(db, { publicKey: ticket.publicKey }, { privateKey: ticket.privateKey })
            }
            return POOL_TARGET
          })),
        When('executing pool maintenance for Game')(({ pool }) => pool.execute(DIM_GAME, NETWORK_WESTEND2)),
        Then('pool count remains at target')(({ db, count }) =>
          Effect.gen(function*() {
            const finalCount = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(finalCount).toBe(count)
          })
        ),
        And('no new tickets are registered on-chain')(({ fake }) =>
          Effect.gen(function*() {
            const registered = yield* fake.getRegisteredTickets
            expect(HashMap.size(registered)).toBe(0)
          })
        ),
      ),
    )

    scenario(
      'Should_ConvergeToTarget_When_RunRepeatedly',
      scope.pipe(
        When('executing pool maintenance ceil(target / batch) times')(({ pool }) =>
          Effect.gen(function*() {
            const cycles = Math.ceil(POOL_TARGET / BATCH_SIZE)
            for (let cycle = 0; cycle < cycles; cycle++) {
              yield* pool.execute(DIM_GAME, NETWORK_WESTEND2)
            }
          })
        ),
        Then('the pool reaches exactly the target count')(({ db }) =>
          Effect.gen(function*() {
            const count = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(count).toBe(POOL_TARGET)
          })
        ),
      ),
    )

    scenario(
      'Should_StayAtTarget_When_RunAgainAfterConverging',
      scope.pipe(
        Given('the pool has converged to target')(({ pool }) =>
          Effect.gen(function*() {
            const cycles = Math.ceil(POOL_TARGET / BATCH_SIZE)
            for (let cycle = 0; cycle < cycles; cycle++) {
              yield* pool.execute(DIM_GAME, NETWORK_WESTEND2)
            }
          })
        ),
        When('executing pool maintenance again')(({ pool }) => pool.execute(DIM_GAME, NETWORK_WESTEND2)),
        Then('the pool count stays at target')(({ db }) =>
          Effect.gen(function*() {
            const count = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(count).toBe(POOL_TARGET)
          })
        ),
      ),
    )

    scenario(
      'Should_MaintainSeparatePools_When_MultipleDimensions',
      scope.pipe(
        Given('one ticket exists in the Game pool')(({ db }) =>
          Effect.gen(function*() {
            const ticket = yield* generateTestTicket
            yield* insertAvailableTicket(db, { publicKey: ticket.publicKey, dim: DIM_GAME }, {
              privateKey: ticket.privateKey,
            })
          })
        ),
        When('executing pool maintenance for ProofOfInk')(({ pool }) =>
          pool.execute(DIM_PROOF_OF_INK, NETWORK_WESTEND2)
        ),
        Then('the Game pool is untouched')(({ db }) =>
          Effect.gen(function*() {
            const gameCount = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(gameCount).toBe(1)
          })
        ),
        And('the ProofOfInk pool receives a full batch, all tagged ProofOfInk')(({ db, fake }) =>
          Effect.gen(function*() {
            const inkCount = yield* countTickets(db, DIM_PROOF_OF_INK, NETWORK_WESTEND2)
            const registered = yield* fake.getRegisteredTickets
            expect(inkCount).toBe(BATCH_SIZE)
            for (const [, ticket] of registered) {
              expect(ticket.dim).toBe('ProofOfInk')
            }
          })
        ),
      ),
    )

    scenario(
      'Should_DiscardBatchAndRecover_When_BlockchainFailureInjected',
      scope.pipe(
        Given('on-chain registration fails on the next attempt')(({ fake }) =>
          fake.failNext(new OnChainTicketAPIError({ cause: 'simulated connection timeout' }))
        ),
        When('executing pool maintenance while registration is failing')(({ pool }) =>
          pool.execute(DIM_GAME, NETWORK_WESTEND2)
        ),
        Then('no tickets are added to the pool')(({ db }) =>
          Effect.gen(function*() {
            const count = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(count).toBe(0)
          })
        ),
        When('executing pool maintenance again after registration recovers')(({ pool }) =>
          pool.execute(DIM_GAME, NETWORK_WESTEND2)
        ),
        Then('the pool is replenished with a full batch')(({ db }) =>
          Effect.gen(function*() {
            const count = yield* countTickets(db, DIM_GAME, NETWORK_WESTEND2)
            expect(count).toBe(BATCH_SIZE)
          })
        ),
      ),
    )
  })
