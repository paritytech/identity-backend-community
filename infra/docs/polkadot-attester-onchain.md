# Attester On-Chain Setup: Operator Walkthrough

This document explains the on-chain mechanics for granting attestation allowance on the People chain and Asset Hub, who holds the dispatch origin, and exactly what happens when a non-authorized account tries to call these extrinsics.

---

## Pre-requisite: the community bootstrap has run

The on-chain state for the attester account — funding, **`AttestationAllowance` grants on BOTH People and AssetHub**, sudo proxy delegation, DotNS gateway dispatcher address — is owned by the public bootstrap scripts in **`paritytech/individuality-community/tree/main/scripts/initial-setup/`**. This repo does not own those scripts and the SST deploy does not run them.

The canonical grant flow is **`12b-setup-attestation-allowances.sh`** (in that directory), which submits `peopleLite.increase_attestation_allowance` on People AND `dotnsGateway.increase_attestation_allowance` on Asset Hub in one orchestrated run. **`12c-setup-attestation-proxy.sh`** sets the proxy delegation.

If you are reading this document to debug a `NoAttestationAllowance` error or to verify the attester account is correctly set up, first check that `12b` and `12c` have been run for the target network (`local` / `paseo` / `westend2` / `polkadot`) and that the SS58 address derived from `ATTESTER_PUBLIC_KEY` matches the account those scripts granted. The pallet mechanics in the rest of this document explain _what_ those extrinsics do, not _how to submit them_; the community script is the how.

This document is the read-the-code-behind-the-script companion to the community bootstrap. The community script is the source of truth for operator workflow.

---

## People chain: `peopleLite` pallet

**Source:** `paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs`
**Runtime wiring:** `paritytech/individuality-community/tree/main/runtimes/next-people-paseo/src/people.rs:985`

### Extrinsics

#### `peopleLite.increase_attestation_allowance`

| Field               | Value                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Call index**      | `0` (declared with `#[pallet::call_index(0)]`)                                                        |
| **Parameters**      | `account: AccountId` — the attester's SS58 address · `count: u32` — number of attestations to grant   |
| **Dispatch origin** | `AttestationAllowanceManager` — wired to **`EnsureRoot<AccountId>`** in the next-people-paseo runtime |

```rust
// paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs:247-258
#[pallet::call_index(0)]
#[pallet::weight(<T as Config>::WeightInfo::increase_attestation_allowance())]
pub fn increase_attestation_allowance(
    origin: OriginFor<T>,
    account: T::AccountId,
    count: u32,
) -> DispatchResult {
    T::AttestationAllowanceManager::ensure_origin(origin)?;  // ← Root required
    let mut available = AttestationAllowance::<T>::get(&account);
    available = available.saturating_add(count);
    AttestationAllowance::<T>::insert(&account, available);
    Self::deposit_event(Event::AttestationAllowanceIncreased { account, count });
    Ok(())
}
```

#### `peopleLite.clear_attestation_allowance`

| Field               | Value                                            |
| ------------------- | ------------------------------------------------ |
| **Call index**      | `1`                                              |
| **Parameters**      | `account: AccountId`                             |
| **Dispatch origin** | `AttestationAllowanceManager` / **`EnsureRoot`** |

#### `peopleLite.attest` — the registration extrinsic

| Field               | Value                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Call index**      | `2` (declared with `#[pallet::call_index(2)]`)                                                                                                                                                        |
| **Parameters**      | `candidate: AccountId` · `candidate_signature: Signature` · `ring_vrf_key: MemberOf<T>` · `proof_of_ownership: SignatureOf<T>` · `consumer_registration: Option<LiteConsumerRegistrationParamsOf<T>>` |
| **Dispatch origin** | **`Signed`** — any account with non-zero `AttestationAllowance` balance                                                                                                                               |

```rust
// paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs:317-334
pub fn attest(
    origin: OriginFor<T>,
    candidate: T::AccountId,
    candidate_signature: T::AttestationSignature,
    ring_vrf_key: MemberOf<T>,
    proof_of_ownership: SignatureOf<T>,
    consumer_registration: Option<LiteConsumerRegistrationParamsOf<T>>,
) -> DispatchResultWithPostInfo {
    let verifier = ensure_signed(origin)?;  // ← Signed origin, not Root
    // ...
    let available = AttestationAllowance::<T>::get(&verifier)
        .checked_sub(1)
        .ok_or(Error::<T>::NoAttestationAllowance)?;  // ← fails if allowance == 0
    // ...
}
```

### Storage

```rust
// paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs:172
pub type AttestationAllowance<T: Config> =
    StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;
```

`AttestationAllowance(attester: AccountId) → u32` — defaults to `0` if the key is absent (ValueQuery). **A brand-new attester account has zero allowance.** The first `attest` call will always fail with `NoAttestationAllowance` until `increase_attestation_allowance` is called by Root.

### Who holds the origin?

The runtime wires `AttestationAllowanceManager = EnsureRoot<AccountId>`:

```rust
// paritytech/individuality-community/tree/main/runtimes/next-people-paseo/src/people.rs:983-985
impl indiv_pallet_people_lite::Config for Runtime {
    type AttestationAllowanceManager = EnsureRoot<Self::AccountId>;
    // ...
}
```

**`EnsureRoot`** means the call must be submitted by the **Sudo account** (if the chain uses the `pallet_sudo` wrapper) or by an OpenGov referendum passing the **`Root` track**. There is no fallback — a plain signed account **cannot** satisfy `EnsureRoot`.

### Failure modes

| Caller                               | Result                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Attester account itself** (signed) | `BadOrigin` — the `ensure_origin(origin)?` call returns `Err(BadOrigin)` because `EnsureRoot` rejects all signed origins |
| **Any non-Root account**             | `BadOrigin` — same rejection                                                                                             |
| **Root / Sudo account**              | Success (or `DispatchResult::Ok`)                                                                                        |

```rust
// paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs:252
T::AttestationAllowanceManager::ensure_origin(origin)?;  // Err(BadOrigin) for Signed
```

> **"But the attester IS the account — why can't it call itself?"** Because `AttestationAllowanceManager` is `EnsureRoot`, which is satisfied only by the chain's Sudo key or by an on-chain governance proposal passing the Root track. The attester's own private key is a **Signed** origin. These are completely disjoint privilege levels. The attester can call `attest` (which is **Signed**), but cannot call `increase_attestation_allowance` (which is **Root**).

### Error variants

From `pub enum Error<T>` (`people-lite/src/lib.rs:200-223`):

```rust
pub enum Error<T> {
    NoAttestationAllowance,       // attester has 0 allowance when calling `attest`
    InvalidAttestationSignature,  // candidate's signature is wrong
    InvalidProofOfOwnership,      // ring VRF proof is wrong
    AlreadyRegistered,            // candidate already attested
    KeyAlreadyInUse,              // ring VRF key already enrolled
    AccountInUse,                 // this account already attested someone
    AliasAccountAlreadySet,       // alias mapping already current
    AliasAccountNotSet,           // alias mapping not set
    CallBlockOutOfRange,          // block window invalid
    InvalidAliasContext,          // alias context invalid
    LitePeopleCollectionNotCreated, // collection not initialized
}
```

**Source:** `paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs`
**Runtime proof:** `paritytech/individuality-community/tree/main/runtimes/next-people-paseo/src/people.rs:985`

---

## Asset Hub: `dotnsGateway` pallet

**Source:** `paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs`
**Runtime wiring:** `paritytech/individuality-community/tree/main/runtimes/next-asset-hub-paseo/src/lib.rs:1282`

### The attester must have BOTH allowances

On Asset Hub, the `dotnsGateway` pallet is a **separate pallet on a separate chain** (Asset Hub, not People chain). The attester account that can call `peopleLite.attest` on the People chain **also needs a separate allowance on Asset Hub** to call `dotnsGateway.reserve_name`. The two allowances are independent storage items on independent chains.

```rust
// Asset Hub storage — paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs:172
pub type AttestationAllowance<T: Config> =
    StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;  // separate from People chain
```

### Extrinsics

#### `dotnsGateway.increase_attestation_allowance`

| Field               | Value                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| **Call index**      | `2` (declared with `#[pallet::call_index(2)]`)                                                           |
| **Parameters**      | `account: AccountId` · `count: u32`                                                                      |
| **Dispatch origin** | `AttestationAllowanceManager` — wired to **`EnsureRoot<AccountId>`** in the next-asset-hub-paseo runtime |

```rust
// paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs:455-466
#[pallet::call_index(2)]
#[pallet::weight(<T as Config>::WeightInfo::increase_attestation_allowance())]
pub fn increase_attestation_allowance(
    origin: OriginFor<T>,
    account: T::AccountId,
    count: u32,
) -> DispatchResult {
    T::AttestationAllowanceManager::ensure_origin(origin)?;  // ← Root required
    AttestationAllowance::<T>::mutate(&account, |old| {
        *old = old.saturating_add(count);
    });
    Self::deposit_event(Event::AttestationAllowanceIncreased { account, count });
    Ok(())
}
```

#### `dotnsGateway.clear_attestation_allowance`

| Field               | Value                                            |
| ------------------- | ------------------------------------------------ |
| **Call index**      | `3`                                              |
| **Dispatch origin** | `AttestationAllowanceManager` / **`EnsureRoot`** |

#### `dotnsGateway.set_dispatcher_address`

| Field               | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| **Call index**      | `4`                                                                |
| **Parameters**      | `address: H160` — the `RootGatewayDispatcher` contract address     |
| **Dispatch origin** | `DispatcherAddressManager` — also **`EnsureRoot`** in this runtime |

```rust
// paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs:1283
type DispatcherAddressManager = EnsureRoot<AccountId>;
```

#### `dotnsGateway.reserve_name` — the registration extrinsic

| Field               | Value                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Call index**      | `0`                                                                                                                                                                                |
| **Parameters**      | `candidate: AccountId` · `candidate_signature: AttestationSignature` · `lite_label: BaseLabel` · `chat_key: ChatKey` · `reserved_base_label: Option<BaseLabel>` · `signed_at: u64` |
| **Dispatch origin** | **`Signed`** — any account with non-zero `AttestationAllowance` on Asset Hub                                                                                                       |

```rust
// paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs:316-364
pub fn reserve_name(
    origin: OriginFor<T>,
    candidate: T::AccountId,
    candidate_signature: T::AttestationSignature,
    lite_label: BaseLabel,
    chat_key: ChatKey,
    reserved_base_label: Option<BaseLabel>,
    signed_at: u64,
) -> DispatchResultWithPostInfo {
    let attester = ensure_signed(origin)?;  // ← Signed, not Root
    // ...
    let available = AttestationAllowance::<T>::get(&attester)
        .checked_sub(1)
        .ok_or(Error::<T>::NoAttestationAllowance)?;  // ← fails if allowance == 0
    // ...
}
```

### Failure modes

| Caller                                                                        | Result                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Attester account itself** (signed) calling `increase_attestation_allowance` | `BadOrigin` — `EnsureRoot` rejects signed origins                                                    |
| **Any non-Root account** calling allowance management                         | `BadOrigin`                                                                                          |
| **Root / Sudo account**                                                       | Success                                                                                              |
| **Attester with zero allowance** calling `reserve_name`                       | `NoAttestationAllowance` — the extrinsic succeeds on-chain but returns `Err(NoAttestationAllowance)` |

### Error variants

From `pub enum Error<T>` (`dotns-gateway/src/lib.rs:251-277`):

```rust
pub enum Error<T> {
    AlreadyRegistered,              // alias already registered a name
    ContractCallFailed,            // low-level contract call failure
    ContractRevert(DispatcherRevert), // typed contract revert
    InvalidName,                   // bad DNS/lite-label format
    NoAttestationAllowance,        // allowance == 0 on reserve_name
    InvalidAttestationSignature,   // candidate signature invalid
    ReservationSignatureExpired,   // signature too old
    ReservationSignatureFromFuture, // signature timestamp in future
    NotLiteLabelOwner,             // caller doesn't own the lite label
    DispatcherAddressNotSet,       // contract address not yet set
}
```

**Source:** `paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs`
**Runtime proof:** `paritytech/individuality-community/tree/main/runtimes/next-asset-hub-paseo/src/lib.rs:1282-1283`

---

## The on-chain allowance gotcha (governance origin)

> ⚠️ **This is the first-time operator's primary stuck point.**

The workflow described in `paritytech/individuality-community/tree/main/docs/operations.md` states:

> "Every privileged call in the Individuality pallets is gated by a manager origin that the pallet defines itself (`AttestationAllowanceManager`, etc.). These origins can be the same account or several different ones — **it is up to the runtime**. How those origins are satisfied is a deployment choice: whoever deploys the runtime decides how to back each one — **sudo (`EnsureRoot`), a proxy, governance, or a dedicated account per role**."

Both the People chain and Asset Hub runtimes wire `AttestationAllowanceManager = EnsureRoot<AccountId>`. This means:

1. **The operator who deploys the backend is not the chain admin.** They cannot call `increase_attestation_allowance`.
2. **The chain admin (Root / Sudo key holder) is a separate party.** They hold the key that can grant allowances.
3. **The backend will fail silently on first start** — `attest` / `reserve_name` returns `NoAttestationAllowance`, not `BadOrigin`, because the attester account exists and can sign, but has 0 allowance.

### The step the operator must perform

1. **Deploy the backend service.** It will expose `GET /api/v1/attester`, which returns the attester's public key (32-byte hex, no `0x` prefix, no SS58 encoding).

2. **Contact the chain governance admin.** Provide the attester public key and request that they run:

   **On People chain (Paseo testnet):**
   ```
   peopleLite.increase_attestation_allowance(
     account: <attester SS58 address>,
     count: 1000  -- or any reasonable batch size
   )
   ```

   **On Asset Hub (Paseo testnet):**
   ```
   dotnsGateway.increase_attestation_allowance(
     account: <attester SS58 address>,
     count: 1000
   )
   ```

   Both calls require the submitter to have **Root origin** (Sudo or governance proposal on the Root track).

3. **If the operator IS the chain admin** (running a private testnet), they use the Sudo pallet directly in Polkadot.js Apps:
   - Go to **Developer → Sudo** (or **Extrinsics** and select `sudo.sudo` as the submission origin)
   - Submit `peopleLite.increaseAttestationAllowance` or `dotnsGateway.increaseAttestationAllowance`

4. **On a public testnet** (Paseo), the Root origin is controlled by OpenGov. There is no direct "sudo" button. A proposal must go through the OpenGov Root track. Contact the Paseos network operators via their communication channels (typically Element/Matrix or a designated governance forum).

> **The key insight:** The operator generates the key, sets `ATTESTER_PUBLIC_KEY`, and deploys. The **chain admin** grants the allowance. These are two separate roles.

**Source:** `paritytech/individuality-community/tree/main/docs/operations.md:5-13`

---

## First-deploy stuck points

### 1. Allowance is zero — `NoAttestationAllowance`

```
Error: NoAttestationAllowance
```

The backend calls `peopleLite.attest` or `dotnsGateway.reserve_name`. The attester account is valid (it signed the transaction), but its `AttestationAllowance` storage entry is `0`. The extrinsic submission succeeds on-chain (the signature is valid, the fee is paid), but the inner call returns `Err(NoAttestationAllowance)`.

**Fix:** The chain admin must call `increase_attestation_allowance` with Root origin.

---

### 2. `ATTESTER_PUBLIC_KEY` has wrong length — `Config.mapOrFail` fails at startup

The `ATTESTER_PUBLIC_KEY` env var must be a **32-byte hex string** (64 hex characters, no `0x` prefix). If the string is the wrong length, the `Config` layer's `mapOrFail` rejects it and the server refuses to start.

```
Error: Config mapOrFail failed: Invalid hex string length for attester public key
```

**Fix:** Verify the hex string is exactly 64 characters (`0x`-stripped). Use:

```bash
echo -n "$ATTESTER_PUBLIC_KEY" | wc -c   # must print 64
```

---

### 3. `ATTESTER_PROXY_PRIVATE_KEY` is the 64-byte expanded key, not the mnemonic

The key expansion script (using `@polkadot-labs/hdkd-helpers` + the workspace's `@identity-backend/crypto`) produces a **64-byte hex string** (128 characters, with `0x` prefix). This is the **expanded Ed25519 secret**, not the 32-byte raw seed from `subkey inspect <mnemonic> --scheme Ed25519`.

If the operator mistakenly pastes the 32-byte seed or the original mnemonic, the backend will fail to sign transactions.

**Fix:** Confirm the key expansion script outputs a 128-character hex string (`0x` + 128 hex chars = 130 total chars).

---

### 4. The dedicated invitation-pool account follows the same proxy pattern

`INVITER_POOL_PRIVATE_KEY` is a second proxy submitter for the attester authority, used by the invitation-ticket pool daemon so its refill traffic does not contend with username registration on the shared submission permit. It follows the exact same rules as `ATTESTER_PROXY_PRIVATE_KEY` above:

- It is the **expanded 64-byte** sr25519 private key (128 hex chars), never the 32-byte seed or the mnemonic.
- It is **network-agnostic** — the same private key signs on any network.
- Its **proxy delegation** must be registered on-chain before it can submit. The community bootstrap script `12c-setup-attestation-proxy.sh` (in `paritytech/individuality-community`) is the source of truth for registering the proxy relationship; this repo's SST deploy does not run it.
- It must be **funded** with existential deposit + transaction fees on the People chain.
- Pair with `INVITATION_TICKET_POOL_TARGET` / `INVITATION_TICKET_BATCH_SIZE` — raise those values only after the dedicated pool key is in place, so the higher refill traffic does not contend with username registration on the shared signer.

---

## Faucet gotchas

### Paseo testnet

- **URL:** <https://faucet.paseo.org/>
- **Wait time:** ~30 seconds to receive PAS tokens
- **Rate limiting:** The faucet may impose a cooldown per IP or account. If rate-limited, wait 5–10 minutes and retry, or seek PAS from a community channel.

### Westend2 testnet

- **URL:** <https://faucet.polkadot.io/>
- **Wait time:** ~1–2 minutes
- **Note:** Westend2 faucet distribution can be inconsistent during high-traffic periods.

### Polkadot mainnet

- **There is NO faucet.**
- **Minimum funding:** 1 DOT for existential deposit (account survival) + 5–10 DOT for transaction fees over initial operation.
- **Procedure:** Buy DOT on an exchange (Kraken, Binance, Coinbase, etc.), withdraw to the attester's SS58 address on Polkadot mainnet.

---

## SS58 address encoding

The SS58 address format includes a **network prefix** that changes the human-readable address for the same 32-byte public key:

| Network         | SS58 prefix | Same key → different address |
| --------------- | ----------- | ---------------------------- |
| Polkadot        | `0`         | e.g., `1ABC...XYZ`           |
| Kusama          | `2`         | e.g., `J7VV...LMN`           |
| Westend         | `42`        | e.g., `cNV...PQR`            |
| Paseo (testnet) | `10041`     | e.g., `4Cc...STU`            |

### What this means for the operator

- **`ATTESTER_PUBLIC_KEY`** — This is the **raw 32-byte public key** in hex. It is **network-agnostic**; the same key works on all networks. The backend uses this internally and encodes it to the correct SS58 for the target chain automatically.

- **`ATTESTER_PROXY_PRIVATE_KEY`** — The **expanded 64-byte private key** is also **network-agnostic**. The same private key signs transactions on any network.

- **SS58 address used in Polkadot.js Apps / governance UIs** — Must match the **target network**. If the operator generates an address on Westend but deploys to Paseo, they will see a different SS58 string — but the underlying key is identical. Always use the SS58 prefix corresponding to the chain you're operating on.

- **Key generation must happen on the target network** if using a tool that embeds the SS58 prefix (e.g., `subkey generate --network paseo`). If the operator generates on the wrong network and imports the raw key elsewhere, the public key is still correct but the SS58 address display will differ.

---

## Quick reference: call signatures and origins

### People chain — `peopleLite` pallet (index `62`)

| Extrinsic                        | Call index | Parameters                                                   | Origin                                       | Who can call                         |
| -------------------------------- | ---------- | ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------ |
| `increase_attestation_allowance` | `0`        | `(account: AccountId, count: u32)`                           | `AttestationAllowanceManager` → `EnsureRoot` | Root / Sudo / OpenGov Root track     |
| `clear_attestation_allowance`    | `1`        | `(account: AccountId)`                                       | `AttestationAllowanceManager` → `EnsureRoot` | Root / Sudo / OpenGov Root track     |
| `attest`                         | `2`        | `(candidate, signature, ring_vrf_key, proof, consumer_reg?)` | `Signed` (with allowance)                    | Any attester with non-zero allowance |

### Asset Hub — `dotnsGateway` pallet (index `53`)

| Extrinsic                        | Call index | Parameters                                                                                | Origin                                       | Who can call                         |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| `reserve_name`                   | `0`        | `(candidate, candidate_signature, lite_label, chat_key, reserved_base_label?, signed_at)` | `Signed` (with allowance)                    | Any attester with non-zero allowance |
| `increase_attestation_allowance` | `2`        | `(account: AccountId, count: u32)`                                                        | `AttestationAllowanceManager` → `EnsureRoot` | Root / Sudo / OpenGov Root track     |
| `clear_attestation_allowance`    | `3`        | `(account: AccountId)`                                                                    | `AttestationAllowanceManager` → `EnsureRoot` | Root / Sudo / OpenGov Root track     |
| `set_dispatcher_address`         | `4`        | `(address: H160)`                                                                         | `DispatcherAddressManager` → `EnsureRoot`    | Root / Sudo / OpenGov Root track     |

---

## Sources

- **People Lite pallet source:** `paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs`
- **DotnsGateway pallet source:** `paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs`
- **People chain runtime wiring:** `paritytech/individuality-community/tree/main/runtimes/next-people-paseo/src/people.rs:985`
- **Asset Hub runtime wiring:** `paritytech/individuality-community/tree/main/runtimes/next-asset-hub-paseo/src/lib.rs:1282-1283`
- **Operations guide:** `paritytech/individuality-community/tree/main/docs/operations.md`
- **Substrate origins:** <https://docs.substrate.io/build/origins/>
- **Polkadot OpenGov:** <https://wiki.polkadot.network/docs/learn-polkadot-opengov>
- **Polkadot origins and fees:** <https://wiki.polkadot.network/docs/learn-origins-and-fees>
- **Polkadot.js Apps (extrinsics):** <https://polkadot.js.org/apps/>
