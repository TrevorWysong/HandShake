# Upgrading the network

How HandShake ships a change to its rules without stranding anyone's payments, history or store.

## Two kinds of change

- **Coordinator changes** (anything outside the integrity zomes: screens, reads, workflows) keep the DNA hash. Ship a new app version, and runtimes swap the new code in. Nothing moves, and the network carries on. Most changes are this kind.
- **Integrity changes** (entry types, link types, validation, DNA properties) produce a new DNA, which is a **new network**. Validation on one network can't read another, so people have to *move* to it. This document is about that.

Keep integrity changes rare: batch them into network versions, and prefer additive changes (a new entry type, a field with `#[serde(default)]`). Every DNA version is a migration everyone has to make.

## The protocol

Holochain 0.7 provides the primitives:
- `close_chain` writes a final action that names the new DNA;
- the network's agent-activity authorities reject anything after it;
- init properties can seed a new chain.

HandShake builds account migration on top of them.

Holochain 0.7.1 adds a fourth, which HandShake uses within a network rather than between them: installing an app with `restore_from_dht` rebuilds an existing key's chain on a new device -- how an account moves to a new phone with its key (RECOVERY.md).

### 1. The new version names its network

Nothing is announced on the old network. The person installs the new version, chooses "I already have an account" → "From the previous version", and the new version shows a **move code**: its network (DNA hash) and the account's new key there (`handshake-upgrade:…`). That code, from an app the person installed themselves, is the only thing that points an account anywhere; nobody else can. In the old version, Account & recovery → New version reads it.

### 2. Leaving the old network

The old app makes one call, `account::migrate_out`:

- It refuses while something would be stranded:
  - orders in progress, in any role;
  - payments this account held, as a store or driver, that it hasn't settled yet (`dispatch::my_unsettled_holds`): only this key can charge them, so after the close they'd lapse uncharged.
- It seals a **parcel** to the new key: the person's name, phone, saved addresses, favourites and allergies, which only the old key could read.
- It writes a validated **`Migration`** entry naming the new network and the new key, with a link for the new key.
- It **closes the chain** (`close_chain`).

Holochain rejects anything after the close: since 0.7.1 the author's own conductor refuses to write it, and the network's authorities reject it.

### 3. Money

There's no balance to carry: money never lived on the network ([DIRECT_PAYMENTS.md](DIRECT_PAYMENTS.md)). A store or driver connects their processor account on the new version, and payers' cards are held by whoever they pay there.

### 4. Arriving

A release made while people move carries the previous network as a second app role, `previous`, built from that release's exact bundle: `npm run package -- --previous deploy/releases/<previous>`. The new key gets a cell there too, so the new app can read the old network directly:

- **`arrive`** records an `Arrival` on the new network, naming the old account and its migration.
- **`arrived_from`** checks it *on the previous network*, through a bridge call to the `previous` role. The migration has to exist, be the old account's, name this key and this network, and its chain has to be closed. Validation on the new network can't read the old one, so apps check this whenever they read it, the same way a recovery has to still stand.
- **The parcel** is opened on the previous network, and the profile is re-created from it plus the old public profile.
- **Stores** are republished by `catalog::import_store`, reading the old store through the bridge: details, choice groups, menu and live promo codes, every reference remapped. A `StoreImport` records where each one came from.
- **Ratings and reputation**, for people and for stores, add the previous network's summaries once `arrived_from` / `imported_from` confirm the link.
- **Rewards:** the import copies the store's program, its items and groups remapped (`rewards::carry_program`). As a member's account leaves, `migrate_out` seals the grants it was given to its new key (`rewards::carry_my_gifts`). On their first order at the store that came over, their app shows the store those grants. The store's new key then asks the old network what the member held (`carried_balance`), played from its public records and those gifts. The old network answers only the store's owner, or the key its owner's migration names. The member is granted that as points carried over (`GrantReason::Carried`). Tier and history start again; docs/REWARDS.md, "When a store moves".
- **First-order deal cards:** a store that came over still knows which cards took its first-order deal: each new claim is checked against the old store's, through the bridge (`newcomer_card_claim`), by fingerprint, on the same device.

### Across versions

The old network runs whatever release it was, which may be older than the bridge a new version would like to use. So each version lists what it answers beyond what every version does (account's `bridge_features`; `coordinator_support::bridge`). The next version asks before relying on any of it, and tells three answers apart:
- **It answers the feature:** used.
- **It's too old to list anything:** Holochain itself says the function doesn't exist there, and the network still answers what every version does. That's a final no: the new version does without, once, and never retries. Any other failure, even one that clears up a moment later, is the third answer, never taken for this one (`coordinator_support::asked`, unit-tested, and checked against release 0.2.0's real DNA).
- **It can't be asked just now:** tried again later.

| Feature | From a release that has it | From one that doesn't |
| --- | --- | --- |
| `rewards-carry:v2` | members' points, earned and given, are carried as a grant on their first order at the store that came over | the program comes over; points don't: members start afresh, and the store can give them points itself |
| `deal-cards:v3` | the store's first-order deal checks the cards its old store claimed | its claims start afresh on the new network; one first order per account still holds |

Releases 0.1.0 and 0.2.0 have neither: this release is the first to list them. `tests/tryorama/src/cross-version.test.ts` moves a store and a member from an earlier release's real DNA (`fixtures/previous-release`, built from its commit by `scripts/previous-release.sh`; rebuild it as each release ships). It checks that everything this version does without fails nothing. `rewards-migration.test.ts` covers the carry between two networks that both have it.

### What doesn't move, and the limits

- **Payments mid-order.** Moving out is refused while orders are active, or while payments this account held are still settling.
- **Recovery plans, guardians and vouches** are network-scoped. People set them up again on the new network. The app could carry the plan in the parcel; that's not done yet.
- **History reaches back one version.** The new app reads the network just before it. To reach further back, a release would carry more than one previous role.
- **The old network has to stay up during the move.** Its peers serve the history the new network reads. Keep the old bootstrap and relay servers running until everyone who's going to move has moved. History on the old network lasts as long as some peers still hold it.

## Update safety

HandShake ships a network of independent copies, not a server: people run different versions, keep data on their own devices, and work offline. What protects them through an update, and what's still to build:

| Concern | Holds today | Still to do |
| --- | --- | --- |
| **Versioned schemas** | The DNA hash is the protocol version: any change to entry types, link types, validation or DNA properties is a new network, never a silent reinterpretation of old records. Every entry decodes only its own fields (`#[serde(deny_unknown_fields)]`), so no version misreads another's record. | A written list of each network version and what changed in it, kept with `deploy/releases/`. |
| **Mixed versions on one network** | Peers on one network all validate with the same integrity zomes, so a newer app can't write what an older peer rejects, nor the reverse. Coordinator changes only change how a device reads and writes its own data. | Peers talk directly through remote signals (`RemoteSignal`). A variant an older app doesn't know is dropped, not misread, but nothing tests a mixed-version pair yet. Add a test with two coordinator versions on one DNA, before relying on it. |
| **Compatibility policy** | A new network reads exactly one version back (the `previous` role). Coordinator releases on one network are interchangeable. | Say, per release, how long the previous network is kept up and readable, and when its `previous` role is dropped. |
| **Crash-safe migration** | Leaving is one call, `migrate_out`: its checks, the parcel, the `Migration` entry and the chain's close commit together or not at all. It refuses while anything would be stranded, and fails closed when it can't tell. | Arriving is several steps (arrival, profile, store import). Test each being cut short and run again: each should be safe to repeat, and none should be lost. |
| **Rollback** | A coordinator release can be rolled back: same network, same data. | **Rolling the app back doesn't roll the data back.** A chain closed by `migrate_out` stays closed: no older app can reopen it, and the account carries on only on the new network. A desktop install keeps its data per version line (`desktop/README.md`), so reinstalling an older line's app starts on that line's data, not the newer one's. Each release note should say which of its changes can be rolled back. |
| **Rehearsal at real size** | `tests/tryorama/bench/scale.ts` measures long accounts, big menus and busy areas; `migration.test.ts` moves a small account end to end. | Rehearse a move of a store and its regulars at the sizes the benchmark reaches, before a real migration. |
| **Release channels** | Desktop releases are drafts until the owner publishes them, and an unsigned build never updates itself (`desktop/README.md`). | Beta and stable channels, so a release reaches a few people first. |
| **Monitoring** | None: no server sees the network. | An opt-in health report from apps (version, failed calls, ops stuck in validation), or a monitoring peer run by the operator. Ops stuck in validation limbo are what HOLOCHAIN_ISSUES.md #11 looked like. |

## For the operator, step by step

1. Build the new release with the changed integrity zomes. Use a new network seed, such as `handshake-2027`, and carry the previous release:
   - `npm run package -- --network-seed handshake-2027 --previous deploy/releases/handshake-2026`
   - Every release writes `deploy/handshake.happ` and `deploy/handshake.network.json`. Keep both for each release, in `deploy/releases/<name>/`.
2. Ship the new release. People move when they open it, from the code it shows.
3. Once moving has tailed off, a later release can drop the `previous` role.

## Where it lives

- `dnas/handshake/zomes/account/coordinator/src/migration.rs`: `migrate_out`, `chain_closed`, `arrive`, `arrived_from`. The `Migration` and `Arrival` entries are in `account_types`.
- `dnas/handshake/zomes/catalog/coordinator/src/moves.rs`: `import_store`, `imported_from` (and the shared store copy).
- `dnas/handshake/zomes/reputation/coordinator`: adds the previous network's summaries.
- `web/scripts/package.ts`: `--previous`.
- Web:
  - `routes/account/UpgradeSheet.tsx`, the move sheet in the old version, reading the move code (`lib/account/accountMove.ts`, `readMoveCode`);
  - `components/account/RestoreAccount.tsx`, "From the previous version" in the new version;
  - `holochain/client.ts`, calls to the `previous` role.
- Tests:
  - `tests/tryorama/src/migration.test.ts`, two real networks end to end;
  - `web/test/accountMove.test.ts`, the move code.
