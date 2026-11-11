# Accounts and recovery

How someone keeps their HandShake account when they change phones, and gets it back when they lose one, on a network with no company that could reset a password.

## The problem

A HandShake account is an agent key. Its private half lives in the keystore of the person's device (the Holochain runtime's lair), and the app never sees it. Changing phones, the old one can send the key on. Lose the device, though, and the key is gone: nothing peer-to-peer can bring it back, and nobody has a copy. With stores, ratings and a store's or driver's in-flight payments riding on it, that loss can't be left to chance.

## Moving to a new phone: the same key

Moving to a new phone while the old one still works keeps the account's **own key**. The old phone sends the key to the new one, sealed so only the new phone can open it. The new phone then rebuilds the account's chain from the network (Holochain 0.7.1's `restore_from_dht`). It's the same account afterwards: the same stores, listings, ratings, history and orders in progress, its payments still its own to settle. Nothing moves to a different key, so nothing has to be re-listed or handed on. A store or driver connects their processor account on the new phone, since its keys stay on the device they were pasted into.

1. **The new phone invites.** Its keystore makes a one-time encryption key, and it shows the public half as a code (`handshake-move:1:…`) with a fingerprint.
2. **The old phone waits for the network.** It scans the code, and the person checks the fingerprint matches on both screens. The account zome's `ready_to_move` then has to say the network's authorities hold this device's latest action. A new phone restores only what the network holds, so nothing the old phone wrote can be left behind.
3. **The old phone stops.** The runtime disables the app: no zome calls, no background work, no answers to other devices. It then shows the account's key sealed to the invitation (`handshake-key:1:…`). The keystore seals it (lair's seed export, a crypto_box from the account key's encryption half to the invitation key), so the key is never readable in between. A photo of the code is useless without the new phone's keystore.
4. **The new phone takes it in.** Its keystore opens the key, checks it's the account the code names, and keeps it exportable, so it can move again. The runtime installs the app for that key with its chain restored, and enables it.
5. **The new phone sets itself up.** A restore brings back the chain but not what was private to the old device. The grants that let signals and handoff codes reach the device are private entries, and background work is the conductor's own state. Each zome's `prepare_device` writes them where they're missing, and nothing where they aren't; the app calls it on every start.
6. **The old phone lets go.** Once the person says the new phone has the account, the old one removes the app. Until then it can take the account back (`stay`), which it offers only with a warning: only if the new phone never finished.

**The one rule: never two phones at once.** Two devices writing with one key fork the account's chain, and the network then refuses the account for good: the new phone's install becomes unrecoverable, and peers flag the key. The steps above prevent it. The old phone stops before the key leaves, sends only once the network holds everything, and is never restarted while the new phone has the key. If it happens anyway, the account comes back the way a lost phone's does, by recovery (below), so the worst case is the same as losing the phone.

**What the network needs.** Holochain restores only a chain head at least two peers agree on (`restore_chain_quorum`), so a phone can't be fed a made-up history by one. With the old phone stopped, that means two other people's apps online that hold the account's history. On a live network they always are. A restore that can't find them yet keeps waiting, and the new phone says so. It also means a single node can't restore at all, so the development host stands in for this step (`web/src/holochain/devDevice.ts`). HOLOCHAIN_ISSUES.md #10 has the details.

**What a phone needs.** The keystore and the conductor's admin side are out of the UI's reach. The runtime hosting the app does this natively (`runtime/device`, the `handshake_device` crate) and gives the UI six commands as `window.__HANDSHAKE_DEVICE__` (see `web/src/holochain/device.ts`). The runtime also creates the account's key itself, exportable, because the conductor's own agent keys can't be exported. A runtime without these commands offers recovery instead.

## Recovery: an account is a line of keys

When the phone is **lost**, its key goes with it. Then the account carries on as a **new key with authority to speak for the old one**. A `Succession` entry on the new key's chain names the account it takes over and the authority it does so on. Validation (`account_integrity`) accepts three kinds of authority:

| Authority | When | What it rests on |
|---|---|---|
| **Recovery phrase** | The phone is lost | A signature by the key the person's twelve words derive, which their `RecoveryPlan` names |
| **Guardians** | The phone is lost | Vouches from at least the plan's threshold of the guardians it names, each from the guardian's own chain |

A plan counts only if it's the account's **latest** as of where the account stood (`head`, an action on its chain). So a phrase the person replaced, or a guardian they removed, can't recover them from that point on.

Each key takes over at most one account. Ratings and reputation for drivers and customers follow the account's line of keys (the reputation zome reads the whole `lineage`). Stores are keyed by their catalog, so they don't move: see *What doesn't move yet*.

### One successor: what the network enforces, and what it doesn't

**This is a real limit of the design, not an unfinished test.** Read it before relying on recovery for an account that matters, such as a busy store's owner.

- **Enforced by validation, on every peer:** a key takes over at most one account; a plan counts only if it's the account's latest; guardians recover only on a plan whose threshold is more than half of them, and each guardian vouches once per account and plan. So two recoveries **by guardians** can't both validate.
- **Not enforced by validation:** that an account has **one** successor. A recovery phrase can sign for any number of keys. Validation sees only the records it's checking, never the whole network, so it can't refuse a second succession, and a check before writing can't stop two made at once.
- **What honest apps do instead:** they read every succession of the account and recognise a successor only if exactly one stands (`successor_of`). Where two do, **neither** inherits history, ratings or stores. A leaked phrase can take an account from its owner, but can't hand it to someone else.
- **Where that falls short:**
  - A modified app can ignore the rule and show a contested account's history under either key.
  - While the network converges, two honest peers can briefly disagree: one has seen only one succession, the other both. Each settles once the second reaches it.
  - The losing key's own chain stays valid, as a lost key's does (*Residual risks*).

So the phrase is as sensitive as the account itself. Keep it offline, and replace it at once if it may have been seen. Before relying on recovery for important business identities, the integrity rules here should have an independent review.

### Identity on the network; money stays where it is

The phrase or guardians prove *who* the person is, peer to peer. Recovery moves no money, because there's none on the network to move: every payment is a card authorization its payee holds on their own processor account ([DIRECT_PAYMENTS.md](DIRECT_PAYMENTS.md)).

- **A customer loses nothing.** Their cards were held by the stores and drivers they paid, who settle as usual.
- **Their allergies have to be added again**, as their addresses do: they were sealed to the lost key. The app says so as recovery finishes, because an empty list would otherwise read as nothing to flag.
- **A store or driver connects their processor account again** on the new key, pasting its keys in again: they never left the lost device. They should revoke the old device's keys from their processor's dashboard, so a found phone can't charge anything. The new key publishes its own payment profile.
- **Payments the lost key held but hadn't settled lapse uncharged.** Only a hold's author settles it, and the network can't tell a lost key from one still in use, so the new key can't settle in its place: a found old phone could then charge the same hold again. A card authorization lapses after about seven days, and its payer is never charged. A store or driver who loses their device loses what was in flight then. That's the price of nobody being able to charge on a lost key's word.

Around that, honest apps treat a key whose account has moved on as finished:

- A store's app won't accept its orders, and a customer's app won't accept its bids (`dispatch::accounts::ensure_not_moved`).
- The device itself shows "Your account has moved" (`MovedAway`).

## Residual risks

| Risk | Why it remains | What limits it |
|---|---|---|
| A thief with an unlocked lost phone acts as the account before recovery | The device's own key is still valid until the owner acts | The phone's lock, plus HandShake's passkey gate in development; recover promptly. A store or driver revokes the device's processor keys from their processor's dashboard. |
| A thief keeps acting as the old key at a colluding store after recovery | Validation can't see the recovery | Honest stores refuse the key. There's no balance for it to spend, and processor keys revoked at the processor charge nothing. |
| A store's or driver's unsettled holds when their device is lost | Only a hold's author settles it | They lapse uncharged within about a week; payers lose nothing. |
| Both phones use the account at once | A modified app, or taking the account back after the new phone already has it | The old phone stops before its key leaves and offers to take it back only with a warning. The network refuses a forked account: the person recovers it as they would a lost phone's. |
| Someone else uses the phrase or the guardians | The phrase *is* the account; guardians are trusted | The old device sees "Your account has moved". Guardians are asked to vouch only after speaking to the person. Validation requires more than half the guardians, so two recoveries by guardians would each need a guardian who vouched for both, which their chain forbids. A phrase can sign for any number of keys, and no validation sees the whole network to stop a second. So where two keys have taken over one account, **neither carries it on** (`successor_of`): no history, ratings or stores pass to either. A leaked phrase can take an account away from its owner, but not hand it to someone else. |
| A plan names its guardians in public | Validation must see who may vouch | Names stay on the device (`guardianNames`); only keys are published. |

When Holochain's DPKI (Deepkey) returns, key revocation at the conductor level could let a recovered key settle what its old key held. The `Succession` record is the natural thing to anchor it to.

## Stores

A store is authored by its merchant's key, and no key can change another's entries. Moving to a new phone keeps the key, so the store stays as it is. On a recovery, though, a store moves by being **republished** by the new key: `move_store` in the catalog zome copies its details, choice groups (nested ones remapped), menu and live promo codes into a store of the new key's own. A `StoreSuccession` ties old to new:

- Validation accepts it only from the key whose `Succession` took over the old store's owner, and each store moves once.
- Ratings follow the store's line (`store_line`), as a person's follow their keys. A move counts only while the succession behind it stands.
- Customers opening the old store are sent on to the new one, and Browse lists only the new one.

## What doesn't move yet

Moving to a new phone keeps the key, so everything stays. On a recovery:

- **Payments the lost key held but hadn't settled.** They lapse uncharged (above).
- **A store's decisions.** Everyone's pay on a delivered order rests on the store's decision about it (`dispatch_types::issues`). If the store's key is lost before it decides, nothing on that order can settle.
- **Goodie bags** are short-lived and aren't copied.

## Where it lives

- `dnas/handshake/zomes/account/`: the plan, vouches, successions and parcels, with their validation.
- `dnas/handshake/zomes/catalog/coordinator/src/moves.rs`: moving a store (`StoreSuccession`).
- `dnas/handshake/zomes/account/coordinator/src/device.rs`: `ready_to_move`; each zome's `prepare_device`.
- `runtime/device/`: the runtime's side of moving to a new phone: keys, codes, restore.
- `dnas/handshake/zomes/dispatch/coordinator/src/accounts.rs`: honest apps refuse moved keys.
- `dnas/handshake/zomes/reputation/coordinator`: reputation follows the account's lineage.
- `web/src/routes/account/`: Account & recovery -- the page, and a sheet for each of the phrase, guardians, moving to a new phone, vouching and moving to a new version.
- `web/src/components/account/RestoreAccount.tsx`: "I already have an account".
- `web/src/lib/account/recoveryPhrase.ts`: BIP-39 words in ten languages, and HKDF under HandShake's own label to Ed25519.
- `web/src/holochain/device.ts`: the runtime's commands to the UI; `devDevice.ts`, development's stand-in.
- `web/src/components/account/Departure.tsx`: the old phone, once it has sent its key.
- Tests:
  - `tests/tryorama/src/device-move.test.ts`: moving to a new phone: ready only once published, the restore, the device set up, the same account carrying on;
  - `runtime/device`: the key moving between real keystores (unit), and between real conductors (`tests/move.rs`, with `--ignored`);
  - `web/test/deviceMove.test.ts`: the codes, as the runtime writes them;
  - `tests/tryorama/src/account.test.ts`: every authority, and the forgeries a modified app would try;
  - `tests/tryorama/src/store-move.test.ts`: a faithful copy, the move's forgeries;
  - `web/test/recoveryPhrase.test.ts`.
