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

Nothing is announced on the old network. The person installs the new version, chooses "I already have an account" → "From the previous version", and the new version shows a **move code**: its network (DNA hash) and the account's new key there (`handshake-move:…`). That code, from an app the person installed themselves, is the only thing that points an account anywhere; nobody else can. In the old version, Account & recovery → New version reads it.

### 2. Leaving the old network

The old app makes one call, `account::migrate_out`:

- It refuses while something would be stranded:
  - orders in progress, in any role;
  - payments this account held, as a store or driver, that it hasn't settled yet (`dispatch::my_unsettled_holds`): only this key can charge them, so after the close they'd lapse uncharged.
- It seals a **parcel** to the new key: the person's name, phone, saved addresses and favourites, which only the old key could read.
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

### What doesn't move, and the limits

- **Payments mid-order.** Moving out is refused while orders are active, or while payments this account held are still settling.
- **Recovery plans, guardians and vouches** are network-scoped. People set them up again on the new network. The app could carry the plan in the parcel; that's not done yet.
- **History reaches back one version.** The new app reads the network just before it. To reach further back, a release would carry more than one previous role.
- **The old network has to stay up during the move.** Its peers serve the history the new network reads. Keep the old bootstrap and relay servers running until everyone who's going to move has moved. History on the old network lasts as long as some peers still hold it.

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
