import { BatchSize } from '#root/batch-backoff/batch-backoff.schema.js'
import { BlockTimeout } from '#root/infrastructure/telemetry/daemons/block-finalization.daemon.js'
import { HexString } from '#root/schema/mod.js'
import { Realm } from '#root/webrtc/webrtc.schema.js'
import { GOOGLE_ROOT_CERTS } from '@identity-backend/android-attest'
import { sr25519 } from '@identity-backend/crypto'
import { JWTInput } from '@identity-backend/play-integrity'
import { Config, ConfigError, Duration, Either, flow, HashSet, pipe, Redacted, Schema as S } from 'effect'
import { createECDH } from 'node:crypto'
import { Network } from './schema/blockchain'

export const GOOGLE_CREDENTIALS = pipe(
  Config.nonEmptyString('GOOGLE_CREDENTIALS'),
  Config.map((s) => s.trim()),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.compose(S.StringFromBase64, S.parseJson(JWTInput))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.withDescription(
    'Base64 encoded JSON string containing Google service account credentials for Play Integrity API',
  ),
)

// Network configuration
export const PEOPLE_NETWORK = pipe(
  Config.literal('westend2', 'polkadot', 'paseo')('PEOPLE_NETWORK'),
  Config.mapOrFail(
    flow(
      S.decodeEither(Network),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription('The People chain network identifier'),
)

export const PEOPLE_RPC_ENDPOINTS = pipe(
  Config.array(Config.nonEmptyString(), 'PEOPLE_RPC_ENDPOINTS'),
  Config.map((endpoints) => endpoints.map((endpoint) => endpoint.trim())),
  Config.withDescription('Array of RPC endpoints for connecting to the People chain'),
)

export const PEOPLE_CHAIN_DESCRIPTOR = Config.literal(
  'previewnet_people',
  'paseo_people',
  'paseo_people_next',
)('PEOPLE_CHAIN_DESCRIPTOR').pipe(
  Config.withDefault('previewnet_people'),
  Config.withDescription('Descriptor used to encode People chain calls for the configured RPC endpoint'),
)

export const WEBSOCKET_HEARTBEAT_TIMEOUT = pipe(
  Config.integer('WEBSOCKET_HEARTBEAT_TIMEOUT'),
  Config.withDefault(60_000),
  Config.map(Duration.millis),
  Config.withDescription(
    'WebSocket heartbeat timeout in milliseconds. Increase for dev environments like chopsticks that may not send keep-alive pings.',
  ),
)

// Account configuration
export const PROXY_PRIVATE_KEY = pipe(
  Config.nonEmptyString('PROXY_PRIVATE_KEY'),
  Config.map((s) => s.trim()),
  Config.map((s) => (s.startsWith('0x') ? s.slice(2) : s)),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.compose(S.Uint8ArrayFromHex, sr25519.PrivateKey)),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.withDescription('Private key for the proxy account that will submit transactions'),
)
export const ATTESTER_PROXY_PRIVATE_KEY = pipe(
  Config.nonEmptyString('ATTESTER_PROXY_PRIVATE_KEY'),
  Config.map((s) => s.trim()),
  Config.map((s) => (s.startsWith('0x') ? s.slice(2) : s)),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.compose(S.Uint8ArrayFromHex, sr25519.PrivateKey)),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.withDescription(
    'Private key for the attester proxy account. Required when PROXY_DELEGATION_ENABLED=true.',
  ),
)
export const INVITER_POOL_PRIVATE_KEY = pipe(
  Config.nonEmptyString('INVITER_POOL_PRIVATE_KEY'),
  Config.map((s) => s.trim()),
  Config.map((s) => (s.startsWith('0x') ? s.slice(2) : s)),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.compose(S.Uint8ArrayFromHex, sr25519.PrivateKey)),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.option,
  Config.withDescription(
    'Optional dedicated signing key for the invitation-ticket pool worker. When set, the pool submits ' +
      'on its own account, so it never contends with username registration on the shared per-account ' +
      'submission permit. Like ATTESTER_PROXY_PRIVATE_KEY, this account is a proxy submitter for the ' +
      'attester authority: it must be funded and registered as a proxy of the attester. Falls back to ' +
      'the existing attester proxy signer (the account the invitation pool uses today) when unset.',
  ),
)

export const ROUTE_TIMEOUT = pipe(
  Config.duration('ROUTE_TIMEOUT'),
  Config.withDefault(Duration.seconds(32)),
  Config.withDescription('Route handler timeout before returning 504'),
)

export const TX_INCLUSION_TIMEOUT_DEFAULT = Duration.seconds(5)

export const TX_INCLUSION_TIMEOUT = pipe(
  Config.duration('TX_INCLUSION_TIMEOUT'),
  Config.withDefault(TX_INCLUSION_TIMEOUT_DEFAULT),
  Config.withDescription(
    'Maximum time from broadcast to best-block inclusion when registering a username on-chain before failing with TxInclusionTimeoutError',
  ),
)

export const PEOPLE_CHAIN_FINALIZATION_TIMEOUT = pipe(
  Config.duration('PEOPLE_CHAIN_FINALIZATION_TIMEOUT'),
  Config.withDefault(Duration.seconds(70)),
  Config.withDescription(
    'Maximum time from best-block inclusion to finalization when registering a username on the People Chain before failing with TxFinalizationError',
  ),
)

export const REGISTER_USERNAME_BATCH_SIZE = pipe(
  Config.integer('REGISTER_USERNAME_BATCH_SIZE'),
  Config.withDefault(100),
  Config.mapOrFail(
    flow(
      S.decodeEither(BatchSize.pipe(S.annotations({ name: 'REGISTER_USERNAME_BATCH_SIZE' }))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription(
    'Maximum number of usernames to process in a single batch when registering on the People chain',
  ),
)

export const ASSET_HUB_RPC_ENDPOINTS = pipe(
  Config.array(Config.nonEmptyString(), 'ASSET_HUB_RPC_ENDPOINTS'),
  Config.map((endpoints) => endpoints.map((endpoint) => endpoint.trim())),
  Config.withDescription('Array of RPC endpoints for connecting to the Asset Hub chain hosting pallet_dotns_gateway'),
)

export const DOTNS_RESERVE_BATCH_SIZE = pipe(
  Config.integer('DOTNS_RESERVE_BATCH_SIZE'),
  Config.withDefault(50),
  Config.mapOrFail(
    flow(
      S.decodeEither(BatchSize.pipe(S.annotations({ name: 'DOTNS_RESERVE_BATCH_SIZE' }))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription(
    'Maximum number of reservations to submit in a single batched dotNS gateway extrinsic',
  ),
)

export const DOTNS_RESERVE_INCLUSION_TIMEOUT = pipe(
  Config.duration('DOTNS_RESERVE_INCLUSION_TIMEOUT'),
  Config.withDefault(TX_INCLUSION_TIMEOUT_DEFAULT),
  Config.withDescription(
    'Maximum time from broadcast to best-block inclusion when submitting a dotNS reservation before failing with TxInclusionTimeoutError',
  ),
)

export const ASSET_HUB_FINALIZATION_TIMEOUT = pipe(
  Config.duration('ASSET_HUB_FINALIZATION_TIMEOUT'),
  Config.withDefault(Duration.seconds(70)),
  Config.withDescription(
    'Maximum time from best-block inclusion to finalization when submitting a dotNS reservation on Asset Hub before failing with TxFinalizationError',
  ),
)

export const DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS = pipe(
  Config.integer('DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS'),
  Config.withDefault(60),
  Config.withDescription(
    'Daemon-side submit margin: seconds shaved off MaxValiditySeconds when the daemon decides ' +
      'whether a reserved row is still fresh enough to submit. Prevents in-flight expiry between ' +
      'pickup and inclusion. Pair with DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS to give the daemon ' +
      'a real budget between intake and submit.',
  ),
)

export const DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS = pipe(
  Config.integer('DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS'),
  Config.withDefault(120),
  Config.withDescription(
    'Strict upper bound on candidate-signature age (seconds) accepted at the register route. ' +
      'MUST leave room for daemon pickup latency + chain inclusion + ' +
      'DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS, otherwise signatures accepted at intake will be ' +
      'silently dropped by the daemon. Invariant enforced at startup against on-chain ' +
      'DotnsGateway.MaxValiditySeconds.',
  ),
)

export const USERNAME_INDEXER_ENABLED = Config.boolean('USERNAME_INDEXER_ENABLED').pipe(
  Config.withDefault(false),
)

export const ADMIN_ROUTE_ENABLED = Config.boolean('ADMIN_ROUTE_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription('Feature flag to enable the admin endpoints'),
)

export const DEBUG_HEAPDUMP_ENABLED = Config.boolean('DEBUG_HEAPDUMP_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription(
    'Feature flag to enable the /debug/heapdump route which streams a V8 heap snapshot. NEVER enable in production.',
  ),
)

export const DEBUG_SQL_ENABLED = Config.boolean('DEBUG_SQL_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription(
    'Feature flag to enable the /debug/query route which proxies read-only SQL queries for diagnostics.',
  ),
)

export const DEBUG_VOUCHER_ENABLED = Config.boolean('DEBUG_VOUCHER_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription(
    'Feature flag to enable the /debug/voucher route which mints and registers a single-use voucher secret for testing. NEVER enable in production.',
  ),
)

export const DEBUG_HEAPDUMP_COOLDOWN_SECONDS = Config.number('DEBUG_HEAPDUMP_COOLDOWN_SECONDS').pipe(
  Config.withDefault(3600),
  Config.withDescription(
    'Minimum seconds between successful /debug/heapdump invocations. Each snapshot blocks the event loop for up to ~30s and exposes in-memory secrets, so the default is one hour. Set to a small value in E2E.',
  ),
)

export const PUSH_SUBSCRIPTIONS_INDEXER_ENABLED = Config.boolean('PUSH_SUBSCRIPTIONS_INDEXER_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription('Feature flag to enable the push subscriptions indexer daemon'),
)

export const WEB_PUSH_ENABLED = Config.boolean('WEB_PUSH_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription('Feature flag to enable browser Web Push subscription and broadcast endpoints'),
)

export const WEB_PUSH_VAPID_KEYPAIR = Config.nonEmptyString('WEB_PUSH_VAPID_PRIVATE_KEY').pipe(
  Config.map((s) => s.trim()),
  Config.mapOrFail(
    flow(
      S.decodeEither(
        S.Uint8ArrayFromBase64Url.pipe(
          S.filter((b) => b.length === 32),
          S.annotations({
            identifier: 'VapidPrivateKey',
            description: 'Base64url-encoded P-256 private key (32 bytes)',
          }),
        ),
      ),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map((rawPrivateKey) => {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(rawPrivateKey)
    return {
      privateKey: Redacted.make(rawPrivateKey),
      publicKey: ecdh.getPublicKey(),
    } as const
  }),
  Config.withDescription('Base64url-encoded P-256 private key; public key derived from it for VAPID'),
)

export const WEB_PUSH_VAPID_SUBJECT = Config.nonEmptyString('WEB_PUSH_VAPID_SUBJECT').pipe(
  Config.withDescription('VAPID subject (mailto: or https: URL) sent with each Web Push send'),
)

export const REGISTRATION_QUEUE_ENABLED = Config.boolean('REGISTRATION_QUEUE_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription('Feature flag to enable the free username registration queue endpoints and daemon'),
)

export const REGISTRATION_QUEUE_MAX_CAPACITY = Config.integer('REGISTRATION_QUEUE_MAX_CAPACITY').pipe(
  Config.withDefault(100000),
  Config.withDescription('Maximum number of entries allowed in the registration queue'),
)

export const INVITATION_TICKET_DAEMON_ENABLED = Config.boolean('INVITATION_TICKET_DAEMON_ENABLED').pipe(
  Config.withDefault(true),
  Config.withDescription('Feature flag to enable the invitation ticket daemon that fills the ticket pool'),
)

export const INVITATION_TICKET_POOL_TARGET = pipe(
  Config.integer('INVITATION_TICKET_POOL_TARGET'),
  Config.withDefault(10_000),
  Config.withDescription(
    'Target available-ticket count per (dim, network) the invitation-ticket pool daemon refills toward. ' +
      'Only raise this in environments where the pool submits on a dedicated account ' +
      '(INVITER_POOL_PRIVATE_KEY); otherwise it contends with username registration.',
  ),
)

export const INVITATION_TICKET_BATCH_SIZE = pipe(
  Config.integer('INVITATION_TICKET_BATCH_SIZE'),
  Config.withDefault(100),
  Config.mapOrFail(
    flow(
      S.decodeEither(BatchSize.pipe(S.annotations({ name: 'INVITATION_TICKET_BATCH_SIZE' }))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription(
    'Max tickets the invitation-ticket pool daemon submits per batch. The dynamic policy halves it on ' +
      'resource exhaustion and grows it back, so a value above the chain per-block limit self-corrects.',
  ),
)

export const FINALIZED_BLOCK_DAEMON_ENABLED = Config.boolean('FINALIZED_BLOCK_DAEMON_ENABLED').pipe(
  Config.withDefault(true),
  Config.withDescription('Feature flag to enable the block finalization monitoring daemon'),
)

export const DOTNS_GATEWAY_ENABLED = Config.boolean('DOTNS_GATEWAY_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription('Master feature flag for the dotNS gateway subsystem'),
)

export const PROXY_DELEGATION_ENABLED = Config.boolean('PROXY_DELEGATION_ENABLED').pipe(
  Config.withDefault(false),
  Config.withDescription(
    'Feature flag to enable proxy account delegation for PeopleLite.attest calls via Proxy.proxy instead of Utility.force_batch',
  ),
)

export const EXPOSE_BUILD_INFO = Config.boolean('EXPOSE_BUILD_INFO').pipe(
  Config.withDefault(false),
  Config.withDescription(
    'Feature flag to register the GET /api/v1/version endpoint that returns the deployed build identity. Default off; flip on per environment for on-call triage, release verification, and client-side error reports.',
  ),
)

export const APP_SERVICE = Config.string('APP_SERVICE').pipe(
  Config.withDefault(''),
  Config.withDescription('Service name for the GET /api/v1/version endpoint. Baked at image build time.'),
)

export const APP_VERSION = Config.string('APP_VERSION').pipe(
  Config.withDefault(''),
  Config.withDescription('Semver for the GET /api/v1/version endpoint. Baked at image build time.'),
)

export const GIT_COMMIT = Config.string('GIT_COMMIT').pipe(
  Config.withDefault(''),
  Config.withDescription('Git commit SHA for the GET /api/v1/version endpoint. Baked at image build time.'),
)

export const BUILD_TIME = Config.string('BUILD_TIME').pipe(
  Config.withDefault(''),
  Config.withDescription('RFC 3339 build timestamp for the GET /api/v1/version endpoint. Baked at image build time.'),
)

export const USERNAME_INDEXER_SYNC_INTERVAL_MS = pipe(
  Config.integer('USERNAME_INDEXER_SYNC_INTERVAL_MS'),
  Config.withDefault(Duration.toMillis('5 minutes')),
  Config.withDescription('Interval in milliseconds between username indexer sync runs'),
)

export const USERNAME_INDEXER_SYNC_RETRY_BASE_DELAY_MS = pipe(
  Config.integer('USERNAME_INDEXER_SYNC_RETRY_BASE_DELAY_MS'),
  Config.withDefault(1000),
  Config.withDescription('Base delay in milliseconds for sync retry exponential backoff'),
)

export const USERNAME_INDEXER_SYNC_RETRY_MAX_ATTEMPTS = pipe(
  Config.integer('USERNAME_INDEXER_SYNC_RETRY_MAX_ATTEMPTS'),
  Config.withDefault(3),
  Config.withDescription('Maximum retry attempts for failed sync operations'),
)

export const USERNAME_INDEXER_LOCK_RETRY_BASE_DELAY_MS = pipe(
  Config.integer('USERNAME_INDEXER_LOCK_RETRY_BASE_DELAY_MS'),
  Config.withDefault(50),
  Config.withDescription('Base delay in milliseconds for lock acquisition exponential backoff'),
)

export const USERNAME_INDEXER_LOCK_RETRY_MAX_ATTEMPTS = pipe(
  Config.integer('USERNAME_INDEXER_LOCK_RETRY_MAX_ATTEMPTS'),
  Config.withDefault(5),
  Config.withDescription('Maximum retry attempts for distributed lock acquisition'),
)

// Authentication configuration
export const AUTH_ENABLED = pipe(
  Config.boolean('AUTH_ENABLED'),
  Config.withDefault(false),
  Config.withDescription('Global flag to enable/disable authentication requirements'),
)
export const ENFORCE_AUTH = pipe(
  Config.boolean('ENFORCE_AUTH'),
  Config.withDefault(false),
  Config.withDescription(
    'When false, requests without auth headers pass through and the App Attest soft gate is active. When true, auth headers ' +
      'are required and every iOS request is App Attest verified.',
  ),
)
export const APPLE_APP_ATTEST_APP_IDS = pipe(
  Config.array(Config.string(), 'APPLE_APP_ATTEST_APP_IDS'),
  Config.withDefault([] satisfies readonly string[]),
  Config.map((appIds) => new Set(appIds)),
  Config.withDescription('List of authorized Apple App IDs for App Attestation'),
)

export const APPLE_TEAM_ID = pipe(
  Config.nonEmptyString('APPLE_TEAM_ID'),
  Config.map((s) => s.trim()),
  Config.withDescription('Apple Developer Team ID for DeviceCheck and App Attest services'),
)

export const DEVICE_CHECK_KEY_ID = pipe(
  Config.nonEmptyString('DEVICE_CHECK_KEY_ID'),
  Config.map((s) => s.trim()),
  Config.withDescription('Key ID for the Apple DeviceCheck private key'),
)

export const DEVICE_CHECK_PRIVATE_KEY_P8 = Config.redacted(
  pipe(
    Config.nonEmptyString('DEVICE_CHECK_PRIVATE_KEY'),
    Config.map((s) => s.trim()),
  ),
).pipe(
  Config.withDescription('Apple DeviceCheck private key'),
)

export const DEVICE_CHECK_URL = pipe(
  Config.nonEmptyString('DEVICE_CHECK_URL'),
  Config.map((s) => s.trim()),
  Config.withDefault('https://api.devicecheck.apple.com/v1'),
  Config.withDescription('Apple DeviceCheck url'),
)

export const DEVICE_CHECK_IOS_ENABLED = pipe(
  Config.boolean('DEVICE_CHECK_IOS_ENABLED'),
  Config.withDefault(false),
  Config.withDescription(
    'Enable Apple DeviceCheck for iOS username registration. When false, the DC middleware and route-side register call become no-ops and DEVICE_CHECK_* env vars are not required at startup. When true, the middleware queries Apple; ENFORCE_AUTH then selects soft (advisory) vs hard (blocking) enforcement.',
  ),
)

export const DEVICE_CHECK_RESET_ENABLED = pipe(
  Config.boolean('DEVICE_CHECK_RESET_ENABLED'),
  Config.withDefault(false),
  Config.withDescription(
    "Feature flag for the admin endpoint that resets a device's DeviceCheck two-bit state. When false, the endpoint is not mounted.",
  ),
)

export const IOS_PACKAGE_NAMES = pipe(
  Config.array(Config.string(), 'IOS_PACKAGE_NAMES'),
  Config.withDefault([] satisfies readonly string[]),
  Config.map((names) => new Set(names)),
  Config.withDescription(
    'List of authorized IOS package names for App Attest',
  ),
)
export const ANDROID_PACKAGE_NAMES = pipe(
  Config.array(Config.nonEmptyString(), 'ANDROID_PACKAGE_NAMES'),
  // Fail fast at startup: an unset env produces a MissingData error from
  // Config.array (no default), and a present-but-empty value is rejected here.
  // An empty allow-list would silently fail the packageName check on EVERY
  // Android attestation, so the app must refuse to boot without it.
  Config.mapOrFail((names) =>
    names.length > 0
      ? Either.right(new Set(names))
      : Either.left(
        ConfigError.InvalidData(
          ['ANDROID_PACKAGE_NAMES'],
          'must list at least one authorized Android package name (e.g. io.pcf.polkadotapp); ' +
            'without it every Android attestation fails the packageName check',
        ),
      )
  ),
  Config.withDescription(
    'Authorized Android package names for TEE attestation / Play Integrity verification. ' +
      'Required — the app refuses to boot if unset or empty.',
  ),
)

export const ANDROID_SIGNING_DIGEST_PLAYSTORE = pipe(
  Config.nonEmptyString('ANDROID_SIGNING_DIGEST_PLAYSTORE'),
  Config.map((s) => s.trim().toLowerCase().replace(/:/g, '')),
  Config.mapOrFail(
    flow(
      S.decodeEither(HexString),
      Either.mapLeft(() => ConfigError.InvalidData(['ANDROID_SIGNING_DIGEST_PLAYSTORE'], 'Not a valid hex string')),
    ),
  ),
  Config.withDescription('SHA-256 fingerprint of the Play Store app signing certificate.'),
)

export const ANDROID_SIGNING_DIGEST_WEBSITE = pipe(
  Config.nonEmptyString('ANDROID_SIGNING_DIGEST_WEBSITE'),
  Config.map((s) => s.trim().toLowerCase().replace(/:/g, '')),
  Config.mapOrFail(
    flow(
      S.decodeEither(HexString),
      Either.mapLeft(() => ConfigError.InvalidData(['ANDROID_SIGNING_DIGEST_WEBSITE'], 'Not a valid hex string')),
    ),
  ),
  Config.withDescription('SHA-256 fingerprint of the website/vanilla APK signing certificate.'),
)

export const ANDROID_ATTESTATION_ROOT_PEMS = pipe(
  Config.array(Config.nonEmptyString(), 'ANDROID_ATTESTATION_ROOT_PEMS'),
  Config.withDefault(GOOGLE_ROOT_CERTS),
  Config.withDescription(
    'PEM-encoded trust anchors for Android key-attestation certificate chains. Defaults to the Google ' +
      'hardware attestation roots; override only to validate chains issued by a test certificate authority.',
  ),
)

export const ANDROID_ATTESTATION_TOKEN_TTL_SECONDS = pipe(
  Config.integer('ANDROID_ATTESTATION_TOKEN_TTL_SECONDS'),
  Config.withDefault(60),
  Config.withDescription(
    'Lifetime in seconds for the short-lived attestation token issued by POST /api/v1/auth/android/attestation. ' +
      'The token must be presented to POST /api/v1/auth/token within this window.',
  ),
)

export const ANDROID_ATTESTATION_CRL_URL = pipe(
  Config.nonEmptyString('ANDROID_ATTESTATION_CRL_URL'),
  Config.withDefault('https://android.googleapis.com/attestation/status'),
  Config.withDescription(
    "URL for Google's Android Keystore attestation revocation list. The response is JSON with an `entries` " +
      'map keyed by certificate serial number. Override only for testing or proxying.',
  ),
)

export const ANDROID_ATTESTATION_CRL_CACHE_TTL = pipe(
  Config.duration('ANDROID_ATTESTATION_CRL_CACHE_TTL'),
  Config.withDefault(Duration.hours(1)),
  Config.withDescription(
    'Cache TTL for the Android attestation revocation list. Default 1 hour per the attestation spec. ' +
      'Refreshes are best-effort: a failed refresh leaves the previous snapshot in place.',
  ),
)

export const CHALLENGE_TTL_SECONDS = pipe(
  Config.integer('CHALLENGE_TTL_SECONDS'),
  Config.validate({
    message: 'CHALLENGE_TTL_SECONDS must be a positive number of seconds',
    validation: (seconds: number) => seconds > 0,
  }),
  Config.withDefault(300),
  Config.withDescription(
    'Lifetime in seconds for challenges issued by POST /api/v1/auth/challenges. A challenge older than this ' +
      'when consumed is treated as not found. Default 5 minutes — long enough for slow networks, short enough ' +
      'to limit replay window. Must be positive: a zero or negative value would reject every token (config DoS).',
  ),
)

export const REQUIRE_CHAIN_FOR_PLAY_INTEGRITY = pipe(
  Config.boolean('REQUIRE_CHAIN_FOR_PLAY_INTEGRITY'),
  Config.withDefault(false),
  Config.withDescription(
    'When true, Android key-attestation certificate chains are REQUIRED for Play Integrity requests. ' +
      'When false (default), missing chains are accepted and Play Integrity runs without chain verification. ' +
      'Independent of ENFORCE_AUTH.',
  ),
)

export const PLAY_INTEGRITY_MODE = pipe(
  Config.literal('strict', 'relaxed_device', 'relaxed_all')('PLAY_INTEGRITY_MODE'),
  Config.withDefault('strict' as const),
  Config.withDescription(
    'Google Play Integrity verification mode. ' +
      '`strict` requires a Play Store build on a hardware-backed device. ' +
      '`relaxed_device` allows real devices with weaker integrity verdicts (nightly/paseo). ' +
      '`relaxed_all` also accepts UNRECOGNIZED_VERSION and UNLICENSED app licensing (preview/debug).',
  ),
)

// System configuration
export const PORT = pipe(
  Config.integer('PORT'),
  Config.withDefault(3000),
  Config.withDescription('Port number for the HTTP server'),
)
export const DATABASE_URL = pipe(
  Config.nonEmptyString('DATABASE_URL'),
  Config.map((s) => s.trim()),
  Config.withDescription('PostgreSQL connection string for the application database'),
)

export const DB_POOL_MAX = pipe(
  Config.integer('DB_POOL_MAX'),
  Config.withDefault(25),
  Config.withDescription('Maximum number of connections in the web database pool'),
)

export const DB_POOL_IDLE_TIMEOUT = pipe(
  Config.duration('DB_POOL_IDLE_TIMEOUT'),
  Config.withDefault(Duration.seconds(45)),
  Config.withDescription('Idle timeout for web database pool connections'),
)

export const DB_POOL_MAX_LIFETIME = pipe(
  Config.duration('DB_POOL_MAX_LIFETIME'),
  Config.withDefault(Duration.minutes(12)),
  Config.withDescription('Maximum lifetime for web database pool connections'),
)

export const DB_POOL_CONNECT_TIMEOUT = pipe(
  Config.duration('DB_POOL_CONNECT_TIMEOUT'),
  Config.withDefault(Duration.seconds(12)),
  Config.withDescription('Connection timeout for the web database pool'),
)

export const DB_POOL_KEEP_ALIVE = pipe(
  Config.duration('DB_POOL_KEEP_ALIVE'),
  Config.withDefault(Duration.seconds(30)),
  Config.withDescription('Keep-alive interval for web database pool connections'),
)

export const DB_POOL_SOCKET_TIMEOUT = pipe(
  Config.duration('DB_POOL_SOCKET_TIMEOUT'),
  Config.withDefault(Duration.seconds(30)),
  Config.withDescription('Socket inactivity timeout for web pool connections (TCP keepalive does not reset it)'),
)

export const DB_STATEMENT_TIMEOUT = pipe(
  Config.duration('DB_STATEMENT_TIMEOUT'),
  Config.withDefault(Duration.seconds(30)),
  Config.withDescription('Postgres statement_timeout for web pool connections'),
)

export const DB_LOCK_TIMEOUT = pipe(
  Config.duration('DB_LOCK_TIMEOUT'),
  Config.withDefault(Duration.seconds(5)),
  Config.withDescription('Postgres lock_timeout for web pool connections'),
)

export const DB_IDLE_IN_TRANSACTION_TIMEOUT = pipe(
  Config.duration('DB_IDLE_IN_TRANSACTION_TIMEOUT'),
  Config.withDefault(Duration.seconds(60)),
  Config.withDescription('Postgres idle_in_transaction_session_timeout for web pool connections'),
)

// TODO: change default to 2 once all daemons are migrated to the leader-election pool
export const LEADER_DB_POOL_MAX = pipe(
  Config.integer('LEADER_DB_POOL_MAX'),
  Config.withDefault(2),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.Int.pipe(S.between(2, 4), S.annotations({ name: 'LEADER_DB_POOL_MAX' }))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription(
    'Max connections for the leader-election pool; bounded 2..4 so a mis-set value fails config decode at ' +
      'startup. Two consumers need a connection — the advisory-lock holder and the reaper daemon — so the floor ' +
      'is 2; the non-blocking lock means more buys nothing. See src/leader-election/AGENTS.md.',
  ),
)

export const LEADER_DB_POOL_IDLE_TIMEOUT = pipe(
  Config.duration('LEADER_DB_POOL_IDLE_TIMEOUT'),
  Config.withDefault(Duration.seconds(30)),
  Config.withDescription('Idle timeout for leader election database pool connections'),
)

export const LEADER_DB_POOL_CONNECT_TIMEOUT = pipe(
  Config.duration('LEADER_DB_POOL_CONNECT_TIMEOUT'),
  Config.withDefault(Duration.seconds(12)),
  Config.withDescription('Connection timeout for the leader election database pool'),
)

export const LEADER_DB_KEEPALIVES_IDLE = pipe(
  Config.duration('LEADER_DB_KEEPALIVES_IDLE'),
  Config.withDefault(Duration.seconds(10)),
  Config.withDescription('TCP keepalive idle time before sending probes on leader election connections'),
)

export const LEADER_DB_REAPER_INTERVAL = pipe(
  Config.duration('LEADER_DB_REAPER_INTERVAL'),
  Config.withDefault(Duration.seconds(60)),
  Config.withDescription('How often the leader election reaper checks for stale entries'),
)

export const REQUEST_SAMPLE_RATE = pipe(
  Config.number('REQUEST_SAMPLE_RATE'),
  Config.withDefault(0.1),
  Config.map((n) => Math.min(n, 1.0)),
  Config.withDescription('Sampling rate for request metrics (between 0 and 1)'),
)
export const FINALIZED_BLOCK_TIMEOUT = pipe(
  Config.number('FINALIZED_BLOCK_TIMEOUT'),
  Config.withDefault(90_000),
  Config.mapOrFail(
    flow(S.decodeEither(BlockTimeout), Either.mapLeft((err) => ConfigError.InvalidData([], err.message))),
  ),
  Config.withDescription('Maximum time (in milliseconds) to wait for a block to be finalized'),
)

export const ADMIN_USERNAME = pipe(
  Config.string('ADMIN_USERNAME'),
  Config.map((s) => s.trim()),
  Config.withDefault('admin'),
  Config.withDescription('Username for the /admin basic-auth gate'),
)
export const ADMIN_PASSWORD = pipe(
  Config.redacted(pipe(
    Config.string('ADMIN_PASSWORD'),
    Config.map((s) => s.trim()),
  )),
  Config.withDefault(Redacted.make('admin')),
  Config.withDescription('Password for the /admin basic-auth gate'),
)

export const DEBUG_USERNAME = pipe(
  Config.string('DEBUG_USERNAME'),
  Config.map((s) => s.trim()),
  Config.withDefault('debug'),
  Config.withDescription('Username for the /debug basic-auth gate'),
)
export const DEBUG_PASSWORD = pipe(
  Config.redacted(pipe(
    Config.string('DEBUG_PASSWORD'),
    Config.map((s) => s.trim()),
  )),
  Config.withDefault(Redacted.make('debug')),
  Config.withDescription('Password for the /debug basic-auth gate'),
)
// External API URLs
export const EXPLORER = pipe(
  Config.literal('Subscan', 'PolkadotJS')('EXPLORER'),
  Config.withDefault('PolkadotJS'),
)
export const EXPLORER_URL = pipe(
  Config.url('EXPLORER_URL'),
  Config.withDefault(new URL('ws://localhost:9944')),
)

export const SENTRY_DSN = pipe(
  Config.nonEmptyString('SENTRY_DSN'),
  Config.map((s) => s.trim()),
  Config.withDescription('Sentry DSN'),
  Config.withDefault(null),
)

export const DEPLOYMENT_ENVIRONMENT = pipe(
  Config.nonEmptyString('DEPLOYMENT_ENVIRONMENT'),
  Config.map((s) => s.trim()),
  Config.withDescription('Deployment environment name (e.g., production, staging, development)'),
  Config.withDefault(null),
)

export const SENTRY_TRACE_SAMPLE_RATE = pipe(
  Config.number('SENTRY_TRACE_SAMPLE_RATE'),
  Config.withDefault(0.1),
  Config.map((n) => Math.max(0, Math.min(n, 1.0))),
  Config.withDescription('Sampling rate for trace export (between 0 and 1)'),
)

export const OTEL_SERVICE_NAME = pipe(
  Config.nonEmptyString('OTEL_SERVICE_NAME'),
  Config.map((s) => s.trim()),
  Config.withDescription('Service name identifier for OpenTelemetry tracing and metrics'),
  Config.withDefault('Identity Backend API'),
)

export const OTEL_SPAN_PROCESSOR = pipe(
  Config.literal('batch', 'simple')('OTEL_SPAN_PROCESSOR'),
  Config.withDescription('OTel span processor: batch for production, simple for tests that must flush before teardown'),
  Config.withDefault('batch' as const),
)

export const JWT_AUTH_SECRET = pipe(
  Config.redacted(pipe(
    Config.nonEmptyString('JWT_AUTH_SECRET'),
    Config.map((s) => s.trim()),
  )),
  Config.withDescription('Secret key used for signing and verifying JWT authentication tokens'),
)

export const JWT_AUTH_ENFORCED = pipe(
  Config.boolean('JWT_AUTH_ENFORCED'),
  Config.withDefault(false),
  Config.withDescription('When true, require JWT on dim-ticket, invitation-ticket, notify, turn, and usernames routes'),
)

const positiveIntBudget = (fallback: number) => (config: Config.Config<number>) =>
  config.pipe(
    Config.withDefault(fallback),
    Config.mapOrFail(
      flow(
        S.decodeEither(S.Int.pipe(S.greaterThanOrEqualTo(1))),
        Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
      ),
    ),
  )

export const RATE_LIMIT_POD_DIVISOR = Config.integer('RATE_LIMIT_POD_DIVISOR').pipe(
  positiveIntBudget(2),
  Config.withDescription(
    'Replica count used to derive each pod-local rate-limit budget from the overall limit. ' +
      'Per-instance budget = ceil(overall / divisor). Tune on scale events.',
  ),
)

export const RATE_LIMIT_AUTH_ACTIONS = Config.integer('RATE_LIMIT_AUTH_ACTIONS').pipe(
  positiveIntBudget(45),
  Config.withDescription(
    'Overall req/min (pre-divisor) for authenticated actions; derived peak×spike in infra/rate-limit-sizing.ts, tune to logs',
  ),
)

export const RATE_LIMIT_REGISTRATION = Config.integer('RATE_LIMIT_REGISTRATION').pipe(
  positiveIntBudget(6),
  Config.withDescription(
    'Overall req/min (pre-divisor) for registration; derived peak×spike in infra/rate-limit-sizing.ts, tune to logs',
  ),
)

export const RATE_LIMIT_PUBLIC_READS = Config.integer('RATE_LIMIT_PUBLIC_READS').pipe(
  positiveIntBudget(90),
  Config.withDescription(
    'Overall req/min (pre-divisor) for public reads, global profile; derived peak×spike in infra/rate-limit-sizing.ts, tune to logs',
  ),
)

export const RATE_LIMIT_PROFILE = pipe(
  Config.literal('shared-nat', 'global')('RATE_LIMIT_PROFILE'),
  Config.withDefault('shared-nat' as const),
  Config.withDescription(
    'Rate-limit topology profile. "shared-nat": high-density shared-IP or CGNAT, where one IP fronts many ' +
      'principals — the origin MUST NOT key on IP (it would throttle the whole shared address), so only ' +
      'per-JWT limiting applies and unauthenticated requests are left to the edge and proof-of-compute. ' +
      '"global": steady state where each client has its own IP — per-IP limiting of unauthenticated requests ' +
      'is safe and enabled. Switch to "global" once the shared-IP condition no longer holds.',
  ),
)

export const MAX_BODY_BYTES_HANDSHAKE = Config.integer('MAX_BODY_BYTES_HANDSHAKE').pipe(
  positiveIntBudget(16 * 1024),
  Config.withDescription(
    'Maximum request body size in bytes for the unauthenticated handshake routes (/api/v1/auth/*) and the ' +
      'push notify routes (/api/v1/notify/*). The Hono body-size gate rejects an over-cap body with a 413 ' +
      'ProblemDetail before any handler — including attestation chain verification — runs. Tune up if a ' +
      'vendor attestation format grows (observe app.body_size_rejections_total first).',
  ),
)

export const MAX_BODY_BYTES_DEFAULT = Config.integer('MAX_BODY_BYTES_DEFAULT').pipe(
  positiveIntBudget(64 * 1024),
  Config.withDescription(
    'Catch-all maximum request body size in bytes for every route without a tighter per-family cap. ' +
      'Enforced by the Hono body-size gate.',
  ),
)

export const MAX_BODY_BYTES_SERVER = Config.integer('MAX_BODY_BYTES_SERVER').pipe(
  positiveIntBudget(4 * 1024 * 1024),
  Config.withDescription(
    'Hard server-wide request-body ceiling in bytes passed to Bun.serve maxRequestBodySize. Last-resort ' +
      'transport gate above the per-route Hono caps; rejects with a transport-layer 413 before the body ' +
      'enters the JavaScript heap.',
  ),
)

export const JWT_TTL = pipe(
  Config.duration('JWT_TTL'),
  Config.withDefault(Duration.minutes(15)),
  Config.mapOrFail((ttl) =>
    Duration.greaterThan(ttl, Duration.zero) && Duration.lessThanOrEqualTo(ttl, Duration.hours(24))
      ? Either.right(ttl)
      : Either.left(ConfigError.InvalidData(['JWT_TTL'], 'JWT_TTL must be > 0 and <= 24h'))
  ),
  Config.withDescription(
    'Access-token TTL; ~15min per RFC 9700 (sensitive, stateless no-revocation so TTL is the revocation latency). Must be 0 < ttl <= 24h',
  ),
)

export const POC_ENABLED = pipe(
  Config.boolean('POC_ENABLED'),
  Config.withDefault(false),
  Config.withDescription(
    'Gate proof-of-compute on search and issue endpoints.',
  ),
)

export const POC_DIFFICULTY_BITS = pipe(
  Config.integer('POC_DIFFICULTY_BITS'),
  Config.withDefault(16),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.Int.pipe(S.between(1, 32), S.annotations({ name: 'POC_DIFFICULTY_BITS' }))),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription(
    'Required leading-zero BITS of the PoC work hash (1..32), counted with clz32 over the first 4 bytes of ' +
      'sha256(sessionId ‖ timestamp ‖ counter). Expected solver cost is ~2^bits hashes, so each bit DOUBLES the ' +
      'work — this is bits, not hex characters. 16 bits ≈ 65,536 iterations ≈ ~10ms on a desktop, the floor at ' +
      'which the gate imposes real cost on a scripted DB-exhaustion attack while staying invisible to a human. ' +
      'A default of 4 (≈16 iterations) is decorative and must not be used in production. Raise toward 18–20 ' +
      '(~0.25–1M iterations) if on-site griefing of /usernames/search is observed; mobile clients hold a JWT and ' +
      'never solve a puzzle, so the cost lands only on unauthenticated (Desktop / scripted) callers.',
  ),
)

export const POC_SESSION_TTL = pipe(
  Config.duration('POC_SESSION_TTL'),
  Config.withDefault(Duration.seconds(60)),
  Config.withDescription('Proof-of-compute puzzle lifetime.'),
)

export const POC_CLOCK_SKEW = pipe(
  Config.duration('POC_CLOCK_SKEW'),
  Config.withDefault(Duration.seconds(30)),
  Config.withDescription(
    'Clock skew tolerance for PoC puzzle timestamps.',
  ),
)

export const APN_PRIVATE_KEY = pipe(
  Config.nonEmptyString('APN_PRIVATE_KEY'),
  Config.map((s) => s.trim()),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.StringFromBase64),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.withDescription('Base64-encoded Apple Push Notification Service authentication key (.p8 content)'),
)

export const APN_PRIVATE_KEY_DEV = pipe(
  Config.nonEmptyString('APN_PRIVATE_KEY_DEV'),
  Config.map((s) => s.trim()),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.StringFromBase64),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.map(Redacted.make),
  Config.option,
  Config.withDescription(
    'Optional base64-encoded APN dev key for dual-environment support. Required only when dual-flow notifications are enabled.',
  ),
)

export const APN_KEY_ID = pipe(
  Config.nonEmptyString('APN_KEY_ID'),
  Config.map((s) => s.trim()),
  Config.withDescription('Apple Push Notification Service key identifier'),
)

export const APN_KEY_ID_DEV = pipe(
  Config.nonEmptyString('APN_KEY_ID_DEV'),
  Config.map((s) => s.trim()),
  Config.option,
  Config.withDescription('Optional APN key identifier for development environment'),
)

export const APN_TEAM_ID = pipe(
  Config.nonEmptyString('APN_TEAM_ID'),
  Config.map((s) => s.trim()),
  Config.withDescription('Apple Developer Team ID for push notifications'),
)

export const APN_TOPICS = pipe(
  Config.array(Config.string(), 'APN_TOPICS'),
  Config.withDefault([] satisfies readonly string[]),
  Config.withDescription('List of bundle identifiers for APN notifications (e.g., com.example.app)'),
)

export const APN_PRODUCTION = pipe(
  Config.boolean('APN_PRODUCTION'),
  Config.withDefault(false),
  Config.map((prod): 'production' | 'development' => prod ? 'production' : 'development'),
  Config.withDescription('Default APN environment for non-development bundle IDs (true=production, false=sandbox)'),
)

export const APN_DEVELOPMENT_SUFFIXES = pipe(
  Config.array(Config.string(), 'APN_DEVELOPMENT_SUFFIXES'),
  Config.withDefault(['.develop'] satisfies readonly string[]),
  Config.map((suffixes) => HashSet.fromIterable(suffixes.map((s) => s.toLowerCase()))),
  Config.withDescription('Bundle ID suffixes that should route to both APN development and production environments'),
)

export const DUAL_FLOW_NOTIFICATIONS_ENABLED = pipe(
  Config.boolean('DUAL_FLOW_NOTIFICATIONS_ENABLED'),
  Config.withDefault(false),
  Config.withDescription(
    'Whether to route APN notifications to both development and production environments for matching bundle ID suffixes',
  ),
)

export const REFRESH_TOKEN_DURATION_DAYS = pipe(
  Config.number('REFRESH_TOKEN_DURATION_DAYS'),
  Config.withDefault(30),
  Config.withDescription('Duration in days for refresh token validity'),
  Config.map(Duration.days),
)

export const ATTESTER_PUBLIC_KEY = pipe(
  Config.nonEmptyString('ATTESTER_PUBLIC_KEY'),
  Config.map((s) => s.trim()),
  Config.map((s) => (s.startsWith('0x') ? s.slice(2) : s)),
  Config.mapOrFail(
    flow(
      S.decodeEither(S.compose(S.Uint8ArrayFromHex, sr25519.PublicKey)),
      Either.mapLeft((err) => ConfigError.InvalidData([], err.message)),
    ),
  ),
  Config.withDescription('Attester public key as a hex string'),
)

// WebRTC / TURN configuration

export const TURN_SECRET = Config.redacted(
  pipe(
    Config.nonEmptyString('TURN_SECRET'),
    Config.map((s) => s.trim()),
    Config.mapOrFail(
      flow(
        S.decodeEither(S.Uint8ArrayFromBase64),
        Either.mapLeft(() => ConfigError.InvalidData(['TURN_SECRET'], 'Invalid base64 encoding')),
      ),
    ),
  ),
).pipe(
  Config.withDescription('Base64-encoded shared secret for HMAC-based TURN credential generation'),
)

export const TURN_AUTH_ALGORITHM = Config.literal('SHA1', 'SHA256', 'SHA384', 'SHA512')('TURN_AUTH_ALGORITHM').pipe(
  Config.withDefault('SHA1'),
  Config.withDescription('HMAC algorithm for TURN credential generation'),
)

export const TURN_TTL = Config.duration('TURN_TTL').pipe(
  Config.withDefault(Duration.minutes(30)),
  Config.withDescription('Time-to-live in seconds for generated TURN credentials'),
)

export const TURN_REALM = Config.nonEmptyString('TURN_REALM').pipe(
  Config.map((s) => s.trim()),
  Config.mapOrFail(
    flow(
      S.decodeEither(Realm),
      Either.mapLeft((err) => ConfigError.InvalidData(['TURN_REALM'], err.message)),
    ),
  ),
  Config.withDescription('TURN server realm for credential generation'),
)

export const ICE_SERVERS = Config.array(Config.nonEmptyString(), 'ICE_SERVERS').pipe(
  Config.mapOrFail(
    flow(
      S.decodeEither(S.Array(S.compose(S.Trim, S.URL))),
      Either.mapLeft((err) => ConfigError.InvalidData(['ICE_SERVERS'], err.message)),
    ),
  ),
  Config.withDefault<readonly URL[]>([] satisfies readonly URL[]),
  Config.withDescription('Array of ICE server URLs (stun:host:port, turn:host:port?transport=udp)'),
)
