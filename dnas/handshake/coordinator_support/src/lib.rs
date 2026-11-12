//! Small helpers shared across coordinator zomes. Nothing here is zome-
//! specific -- it exists so each coordinator crate doesn't have to
//! reimplement the same low-level HDK plumbing.

pub mod chain;
pub mod links;

use hdk::prelude::*;
use handshake_integrity_support::limits::SEAL_CHUNK_BYTES;
pub use handshake_integrity_support::SealedChunks;

/// A refusal the person sees: a zome call's error, as a sentence.
pub fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

/// The record the caller just wrote -- what most writing externs answer
/// with. Read from this device: it's on the caller's own chain.
pub fn written(action_hash: ActionHash) -> ExternResult<Record> {
    get(action_hash, GetOptions::local())?.ok_or(guest("couldn't read back what was just written"))
}

/// The original creation action behind `action_hash` -- itself, unless
/// it's an update, in which case its chain of updates is walked back. The
/// coordinator-side twin of `handshake_integrity_support::original_creation`.
pub fn original_action_of(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let mut current = action_hash;
    loop {
        let record = get(current.clone(), GetOptions::default())?
            .ok_or(wasm_error!(WasmErrorInner::Guest(format!("record {current} not found"))))?;
        match &record.action().data {
            ActionData::Update(update) => current = update.original_action_address.clone(),
            _ => return Ok(current),
        }
    }
}

/// `original_action_of` for each of `hashes`, walked back together -- a
/// read per step back any of them takes, not per hash. `None` for one whose
/// history can't be read.
pub fn originals_of(hashes: &[ActionHash]) -> ExternResult<Vec<Option<ActionHash>>> {
    let mut found: Vec<Option<ActionHash>> = hashes.iter().cloned().map(Some).collect();
    let mut walking: Vec<(usize, ActionHash)> = hashes.iter().cloned().enumerate().collect();
    while !walking.is_empty() {
        let records = read_records(&walking.iter().map(|(_, hash)| hash.clone()).collect::<Vec<_>>())?;
        let mut still = Vec::new();
        for ((i, _), record) in walking.into_iter().zip(records) {
            match record.as_ref().map(|r| &r.action().data) {
                Some(ActionData::Update(update)) => {
                    found[i] = Some(update.original_action_address.clone());
                    still.push((i, update.original_action_address.clone()));
                }
                Some(_) => {}
                None => found[i] = None,
            }
        }
        walking = still;
    }
    Ok(found)
}

/// Resolves an ActionHash to the record's current state, following its
/// updates. `get()` on an ActionHash is literal -- it returns exactly that
/// action, never its latest update -- so this is what lets every extern take
/// one stable reference (the original action) across any number of edits.
pub fn resolve_latest(action_hash: ActionHash) -> ExternResult<Record> {
    Ok(resolve_version(action_hash)?.record)
}

/// `resolve_latest`, telling apart a record this device can't find --
/// `None`: not written, or not reached here yet -- from one it couldn't
/// read just now, which is an error. Where "not there" is an answer (an
/// order not yet seen has nothing to authorize), a failed read mustn't be
/// taken for one.
pub fn find_latest(action_hash: ActionHash) -> ExternResult<Option<Record>> {
    Ok(find_version(action_hash)?.map(|version| version.record))
}

/// An entry's current version, and where it stands among its updates --
/// what the next update builds on (`update_version`).
#[derive(Debug, Clone)]
pub struct EntryVersion {
    /// The entry's original action: its identity.
    pub original: ActionHash,
    pub record: Record,
    /// How many updates below the original it is.
    pub depth: u32,
}

impl EntryVersion {
    /// `record`, written on top of this version.
    pub fn next(&self, record: Record) -> Self {
        Self { original: self.original.clone(), record, depth: self.depth + 1 }
    }
}

/// The current version of the entry `action_hash` is (any version of it).
///
/// Each update is linked from the entry's original, tagged with its depth
/// (`handshake_integrity_support::versions`), so this is one read of those
/// links, asked of the network -- current wherever the updates were
/// written -- and one of the version it picks, which never changes once
/// written, so it's read from this device when it's here. Offline, it's
/// the newest version this device has seen.
///
/// When the history has branched -- two parties updating an order at once,
/// say -- the current version is the deepest; between equally deep ones,
/// the one written first, then the lower hash, so every peer agrees. Never
/// the latest timestamp: an author chooses their own timestamps, so
/// "latest" would let anyone win a branch by dating their update ahead.
/// Nothing that moves money depends on which branch this picks -- each
/// party's held money is settled by the exact version it cites (see
/// `ledger_integrity`) -- it's what screens show and what the next update
/// builds on.
pub fn resolve_version(action_hash: ActionHash) -> ExternResult<EntryVersion> {
    find_version(action_hash)?.ok_or(guest("record not found"))
}

/// `resolve_version`, with `None` for a record found neither here nor on
/// the network -- see `find_latest`. Once the record itself is found,
/// anything its versions say that can't be read is an error: a version
/// linked is a version written.
pub fn find_version(action_hash: ActionHash) -> ExternResult<Option<EntryVersion>> {
    let Some(given) = find_record(action_hash.clone())? else { return Ok(None) };
    let original = match given.action().data {
        ActionData::Update(_) => original_action_of(action_hash)?,
        _ => action_hash,
    };
    let Some(EntryType::App(def)) = given.action().entry_type() else { return Err(guest("that isn't an entry")) };
    let versions = LinkQuery::new(original.clone(), LinkTypeFilter::single_type(def.zome_index, LinkType(handshake_integrity_support::versions::VERSION_LINK_TYPE)));
    // The network's answer, or -- when it can't be reached -- what this
    // device has seen: older, perhaps, but never nothing.
    let links = get_links(versions.clone(), GetStrategy::Network).or_else(|_| get_links(versions, GetStrategy::Local))?;
    Ok(Some(match tip_of(links) {
        Some((depth, hash)) => EntryVersion { original, record: read_record(hash)?, depth },
        None if given.action_address() == &original => EntryVersion { original, record: given, depth: 0 },
        None => EntryVersion { record: read_record(original.clone())?, original, depth: 0 },
    }))
}

/// `resolve_version`, decoded as a `T` -- or an error naming what was
/// expected.
pub fn resolve_version_decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: ActionHash, type_name: &str) -> ExternResult<(EntryVersion, T)> {
    let version = resolve_version(action_hash)?;
    let decoded = decode_or::<T>(&version.record).ok_or(guest(format!("record is not a {type_name}")))?;
    Ok((version, decoded))
}

/// Writes `entry` as the version after `current` -- the entry's current
/// version (`resolve_version`) -- and links it from the entry's original,
/// tagged with its depth, with the zome's own `Version` link type. Each
/// update builds on the current version: updating an older one would
/// branch the history instead of extending it.
pub fn update_version<I, E, L, LE>(current: &EntryVersion, entry: I, version_link: L) -> ExternResult<ActionHash>
where
    Entry: TryFrom<I, Error = E>,
    WasmError: From<E>,
    ScopedLinkType: TryFrom<L, Error = LE>,
    WasmError: From<LE>,
{
    let updated = update_entry(current.record.action_address().clone(), entry)?;
    create_link(current.original.clone(), updated.clone(), version_link, handshake_integrity_support::versions::version_tag(current.depth + 1))?;
    Ok(updated)
}

/// The version `action_hash` is, current or not -- its original and depth,
/// counted back through its updates. For updating a version the caller
/// names exactly (`resolve_version` finds the current one).
pub fn version_at(action_hash: ActionHash) -> ExternResult<EntryVersion> {
    let record = read_record(action_hash)?;
    let mut depth = 0;
    let mut original = record.clone();
    while let ActionData::Update(update) = &original.action().data {
        depth += 1;
        original = read_record(update.original_action_address.clone())?;
    }
    Ok(EntryVersion { original: original.action_address().clone(), record, depth })
}

/// The current version among an entry's `Version` links, and its depth: the
/// deepest, and of two as deep the first written -- what every reader picks.
fn tip_of(links: Vec<Link>) -> Option<(u32, ActionHash)> {
    links
        .into_iter()
        .filter_map(|link| Some((handshake_integrity_support::versions::version_depth(&link.tag)?, link.timestamp, link.target.into_action_hash()?)))
        .max_by(|(d1, t1, h1), (d2, t2, h2)| d1.cmp(d2).then(t2.cmp(t1)).then(h2.cmp(h1)))
        .map(|(depth, _, hash)| (depth, hash))
}

/// Many link reads in one: the host makes them together, where `get_links`
/// in a loop waits on each in turn. Each from the network, or -- when it
/// can't be reached -- what this device has seen.
pub fn get_links_many(queries: Vec<LinkQuery>) -> ExternResult<Vec<Vec<Link>>> {
    let inputs = |strategy: GetStrategy| queries.iter().cloned().map(|query| GetLinksInput::from_query(query, strategy)).collect::<Vec<_>>();
    HDK.with(|h| h.borrow().get_links(inputs(GetStrategy::Network))).or_else(|_| HDK.with(|h| h.borrow().get_links(inputs(GetStrategy::Local))))
}

/// Many records in one read, each from this device when it's here, else the
/// network -- `None` for one found in neither.
pub fn read_records(hashes: &[ActionHash]) -> ExternResult<Vec<Option<Record>>> {
    let get_all = |hashes: Vec<&ActionHash>, options: GetOptions| HDK.with(|h| h.borrow().get(hashes.into_iter().map(|hash| GetInput::new(hash.clone().into(), options.clone())).collect()));
    let mut found = get_all(hashes.iter().collect(), GetOptions::local())?;
    let missing: Vec<usize> = found.iter().enumerate().filter(|(_, r)| r.is_none()).map(|(i, _)| i).collect();
    if !missing.is_empty() {
        for (i, record) in missing.iter().zip(get_all(missing.iter().map(|&i| &hashes[i]).collect(), GetOptions::network())?) {
            found[*i] = record;
        }
    }
    Ok(found)
}

/// The record at `hash`, which validation says exists -- a link's target,
/// a hold's offer, a bid a payment names. One that can't be read hasn't
/// reached this device yet: links and the records they point at travel
/// apart, after a restore especially. So it's an error, never "not
/// there", for anything that adds money, points or authority up.
pub fn arrived(hash: &ActionHash) -> ExternResult<Record> {
    find_record(hash.clone())?.ok_or_else(|| not_arrived(hash))
}

/// `arrived` for each of `hashes`, read together -- every one, or an
/// error. Read from this device only, for `GetStrategy::Local`.
pub fn all_arrived(hashes: &[ActionHash], strategy: GetStrategy) -> ExternResult<Vec<Record>> {
    let records = match strategy {
        GetStrategy::Local => HDK.with(|h| h.borrow().get(hashes.iter().map(|hash| GetInput::new(hash.clone().into(), GetOptions::local())).collect()))?,
        _ => read_records(hashes)?,
    };
    hashes.iter().zip(records).map(|(hash, record)| record.ok_or_else(|| not_arrived(hash))).collect()
}

/// The targets of `links` that are records, in order.
pub fn record_targets(links: Vec<Link>) -> Vec<ActionHash> {
    links.into_iter().filter_map(|link| link.target.into_action_hash()).collect()
}

fn not_arrived(hash: &ActionHash) -> WasmError {
    guest(format!("record {hash} is linked but hasn't reached this device yet"))
}

/// Where each entry at `originals` (their original actions) is now -- its
/// current version's action, or the original itself if it's never been
/// updated -- for many at once, in one read of their version links
/// (`versions`, the zome's `Version` link type).
pub fn latest_versions(originals: &[ActionHash], versions: impl Fn(&ActionHash) -> ExternResult<LinkQuery>) -> ExternResult<Vec<ActionHash>> {
    let queries = originals.iter().map(&versions).collect::<ExternResult<Vec<_>>>()?;
    Ok(get_links_many(queries)?.into_iter().zip(originals).map(|(links, original)| current_of(links, original)).collect())
}

/// Where the entry at `original` is now, from its `Version` links.
pub fn current_of(links: Vec<Link>, original: &ActionHash) -> ActionHash {
    tip_of(links).map_or_else(|| original.clone(), |(_, tip)| tip)
}

/// A record by its action, which never changes once written: from this
/// device when it's here, else the network.
fn read_record(action_hash: ActionHash) -> ExternResult<Record> {
    find_record(action_hash)?.ok_or(guest("record not found"))
}

/// `read_record`, with `None` for one found neither here nor on the
/// network; an error only for a read that failed.
pub fn find_record(action_hash: ActionHash) -> ExternResult<Option<Record>> {
    match get(action_hash.clone(), GetOptions::local())? {
        Some(record) => Ok(Some(record)),
        None => get(action_hash, GetOptions::network()),
    }
}

/// Encrypts `value` from the caller to `recipient` (libsodium box, keyed off
/// both agents' own keys -- nothing to publish or exchange first). Box is
/// symmetric between its two parties: the caller can always re-open what
/// they sealed, so sealing to yourself keeps a value readable only by you.
pub fn seal<T: Serialize + std::fmt::Debug>(recipient: &AgentPubKey, value: &T) -> ExternResult<XSalsa20Poly1305EncryptedData> {
    let me = agent_info()?.agent_initial_pubkey;
    let bytes = ExternIO::encode(value).map_err(|e| wasm_error!(e))?.0;
    ed_25519_x_salsa20_poly1305_encrypt(me, recipient.clone(), XSalsa20Poly1305Data::from(bytes))
}

/// What's sealed padded, and the padding.
#[derive(Serialize, Deserialize, Debug)]
struct Padded<T> {
    value: T,
    pad: String,
}

/// Padded sizes come in steps of this: a box's length says nothing of what's
/// in it, beyond how many steps it fills.
const PAD_STEP: usize = 512;

/// `seal`, for what its size mustn't give away: whether a note has allergies in
/// it, and how many. The box comes out the same length for anything up to a
/// step, and the same for any two in the same step.
pub fn seal_padded<T: Serialize + std::fmt::Debug>(recipient: &AgentPubKey, value: T) -> ExternResult<XSalsa20Poly1305EncryptedData> {
    let encoded_len = |padded: &Padded<&T>| ExternIO::encode(padded).map(|io| io.0.len()).map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())));
    let mut padded = Padded { value: &value, pad: String::new() };
    let bare = encoded_len(&padded)?;
    // A string's header grows with its length, so a step's exact size can fall
    // in the gap: then the next step takes it.
    let mut step = (bare / PAD_STEP + 1) * PAD_STEP;
    loop {
        // What one box holds, with room for the keystore's framing.
        if step > SEAL_CHUNK_BYTES {
            return Err(guest("That's too much to seal in one note. Shorten it a little."));
        }
        let room = step - bare;
        padded.pad = " ".repeat(room);
        for _ in 0..4 {
            let len = encoded_len(&padded)?;
            if len == step {
                return seal(recipient, &padded);
            }
            if len < step {
                break;
            }
            padded.pad.pop();
        }
        step += PAD_STEP;
    }
}

/// Opens what `seal_padded` sealed.
pub fn open_padded<T: for<'de> Deserialize<'de> + std::fmt::Debug>(sender: &AgentPubKey, sealed: &XSalsa20Poly1305EncryptedData) -> ExternResult<Option<T>> {
    Ok(open::<Padded<T>>(sender, sealed)?.map(|padded| padded.value))
}

/// Seals `value` to `recipient` a chunk at a time -- for anything that may
/// be larger than one box holds (a photo); see `SealedChunks`.
pub fn seal_chunked<T: Serialize + std::fmt::Debug>(recipient: &AgentPubKey, value: &T) -> ExternResult<SealedChunks> {
    let me = agent_info()?.agent_initial_pubkey;
    let bytes = ExternIO::encode(value).map_err(|e| wasm_error!(e))?.0;
    let boxes = bytes
        .chunks(SEAL_CHUNK_BYTES)
        .map(|chunk| ed_25519_x_salsa20_poly1305_encrypt(me.clone(), recipient.clone(), XSalsa20Poly1305Data::from(chunk.to_vec())))
        .collect::<ExternResult<Vec<_>>>()?;
    Ok(SealedChunks(boxes))
}

/// Opens `seal_chunked`'s boxes, as `open` does one -- `None` unless the
/// caller can open every one.
pub fn open_chunked<T: for<'de> Deserialize<'de> + std::fmt::Debug>(counterpart: &AgentPubKey, sealed: &SealedChunks) -> ExternResult<Option<T>> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut bytes = Vec::new();
    for sealed_box in &sealed.0 {
        let Ok(chunk) = ed_25519_x_salsa20_poly1305_decrypt(me.clone(), counterpart.clone(), sealed_box.clone()) else { return Ok(None) };
        bytes.extend_from_slice(chunk.as_ref());
    }
    Ok(ExternIO(bytes).decode().ok())
}

/// A photo opened from a sealed field, if it's one the network would have
/// taken in the clear -- an inline raster image -- else none. Validation
/// can't see inside what's sealed, so a modified client could seal a link
/// to a tracker there instead, and every app that showed it would fetch it.
pub fn checked_photo(uri: String) -> String {
    if handshake_integrity_support::image_problem(&uri).is_some() { String::new() } else { uri }
}

/// `text`, cut to `max` characters: sealed text is bounded only by its box.
pub fn at_most(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => text[..cut].to_string(),
        None => text,
    }
}

/// Opens a box exchanged between the caller and `counterpart`, sealed in
/// either direction (`counterpart` is the caller themselves for something
/// they sealed to themselves). `None` when the caller isn't one of its two
/// parties.
pub fn open<T: for<'de> Deserialize<'de> + std::fmt::Debug>(counterpart: &AgentPubKey, sealed: &XSalsa20Poly1305EncryptedData) -> ExternResult<Option<T>> {
    let me = agent_info()?.agent_initial_pubkey;
    let Ok(data) = ed_25519_x_salsa20_poly1305_decrypt(me, counterpart.clone(), sealed.clone()) else { return Ok(None) };
    Ok(ExternIO(data.as_ref().to_vec()).decode().ok())
}

/// The next page's `after` cursor, given the last link in this page.
/// `LinkQuery.after` is inclusive (`>=`), so the cursor steps one
/// microsecond past the last link. Two links in the same microsecond can
/// straddle a page boundary -- acceptable for a browsing list; `ledger`'s
/// balance math, which can't tolerate it, excludes by hash instead.
pub fn next_page_cursor(last_included: Timestamp) -> Timestamp {
    Timestamp::from_micros(last_included.as_micros() + 1)
}

/// The record's entry as a `T`, or `None` if it isn't one.
/// `to_app_option::<T>()` returns `Err` (not `Ok(None)`) for an entry of a
/// different type, so `?` on it turns "that reference isn't a T" into an
/// opaque decode error. Use this for references a caller supplied, which
/// could point at anything; keep `?` where the type is guaranteed.
pub fn decode_or<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    match record.entry().to_app_option::<T>() {
        Ok(Some(v)) => Some(v),
        _ => None,
    }
}

/// `resolve_latest`, decoded as a `T` -- or an error naming what was
/// expected. Returns the record too, since most callers update it next.
pub fn resolve_latest_decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: ActionHash, type_name: &str) -> ExternResult<(Record, T)> {
    let (version, decoded) = resolve_version_decoded(action_hash, type_name)?;
    Ok((version.record, decoded))
}

/// Many entries at their current versions, read together: `resolve_latest`
/// for each of `originals` in three round trips however many there are --
/// their records, their `Version` links, then the versions those name.
/// `None` for one that can't be read, so one bad entry never fails a list.
pub fn resolve_many(originals: &[ActionHash]) -> ExternResult<Vec<Option<Record>>> {
    if originals.is_empty() {
        return Ok(Vec::new());
    }
    let given = read_records(originals)?;
    // Each original's version links, by its own zome's link type. An update
    // given in place of its original is resolved on its own.
    let mut queries = Vec::new();
    let mut asked = Vec::with_capacity(originals.len());
    for (hash, record) in originals.iter().zip(&given) {
        let query = record.as_ref().filter(|r| !matches!(r.action().data, ActionData::Update(_))).and_then(|r| match r.action().entry_type() {
            Some(EntryType::App(def)) => Some(LinkQuery::new(hash.clone(), LinkTypeFilter::single_type(def.zome_index, LinkType(handshake_integrity_support::versions::VERSION_LINK_TYPE)))),
            _ => None,
        });
        asked.push(query.is_some());
        queries.extend(query);
    }
    let mut versions = get_links_many(queries)?.into_iter();
    let tips: Vec<Option<ActionHash>> = asked.iter().map(|&asked| if asked { versions.next().and_then(tip_of).map(|(_, tip)| tip) } else { None }).collect();
    let mut current = read_records(&tips.iter().flatten().cloned().collect::<Vec<_>>())?.into_iter();
    Ok(originals
        .iter()
        .zip(given)
        .zip(asked.into_iter().zip(tips))
        .map(|((hash, given), (asked, tip))| match (asked, tip) {
            (true, Some(_)) => current.next().flatten(),
            (true, None) => given,
            (false, _) => given.and_then(|_| resolve_latest(hash.clone()).ok()),
        })
        .collect())
}

/// Each link's target at its current state, skipping any that don't
/// resolve -- one bad link shouldn't fail a whole list. Read together
/// (`resolve_many`).
pub fn resolve_links_to_records(links: Vec<Link>) -> Vec<Record> {
    resolve_links_to_records_with_original(links).into_iter().map(|(_, record)| record).collect()
}

/// Like `resolve_links_to_records`, keeping each link's target -- the
/// entry's original action, its stable identity -- next to its latest
/// record. The latest record's own hash changes on every update, so it
/// can never stand in for the identity other entries reference.
pub fn resolve_links_to_records_with_original(links: Vec<Link>) -> Vec<(ActionHash, Record)> {
    let targets: Vec<ActionHash> = links.into_iter().filter_map(|link| link.target.into_action_hash()).collect();
    let Ok(records) = resolve_many(&targets) else { return Vec::new() };
    targets.into_iter().zip(records).filter_map(|(target, record)| Some((target, record?))).collect()
}

/// Test-only externs for proving link validation: raw `create_link` /
/// `delete_link`, which an honest coordinator never exposes, so a test can
/// attempt exactly the links a malicious peer would and assert they're
/// rejected. Each coordinator invokes this behind its `test-utils` feature;
/// that build is only ever hot-swapped into test conductors (coordinators
/// aren't part of the DNA hash), never packed into the shipped hApp.
///
/// List every link type the zome defines; `link_type` is matched by name.
#[macro_export]
macro_rules! raw_link_test_externs {
    ($($variant:ident),+ $(,)?) => {
        fn parse_link_type(name: &str) -> ExternResult<LinkTypes> {
            match name {
                $(stringify!($variant) => Ok(LinkTypes::$variant),)+
                other => Err(wasm_error!(WasmErrorInner::Guest(format!("unknown link type {other}")))),
            }
        }

        #[derive(Serialize, Deserialize, Debug)]
        pub struct RawLinkInput {
            pub link_type: String,
            pub base: AnyLinkableHash,
            pub target: AnyLinkableHash,
            #[serde(default)]
            pub tag: Vec<u8>,
        }

        #[hdk_extern]
        pub fn test_create_link(input: RawLinkInput) -> ExternResult<ActionHash> {
            create_link(input.base, input.target, parse_link_type(&input.link_type)?, LinkTag::new(input.tag))
        }

        #[hdk_extern]
        pub fn test_delete_link(create_link_hash: ActionHash) -> ExternResult<ActionHash> {
            delete_link(create_link_hash, GetOptions::default())
        }

        #[derive(Serialize, Deserialize, Debug)]
        pub struct RawLinkQuery {
            pub link_type: String,
            pub base: AnyLinkableHash,
        }

        /// An anchor path's hash, so a test can address a path-based base.
        #[hdk_extern]
        pub fn test_path_hash(path: String) -> ExternResult<AnyLinkableHash> {
            Ok(hdi::hash_path::path::Path::from(path).path_entry_hash()?.into())
        }

        /// The create-link hashes under `base`, so a test can try deleting one.
        #[hdk_extern]
        pub fn test_get_link_hashes(input: RawLinkQuery) -> ExternResult<Vec<ActionHash>> {
            let links = get_links(LinkQuery::try_new(input.base, parse_link_type(&input.link_type)?)?, GetStrategy::default())?;
            Ok(links.into_iter().map(|link| link.create_link_hash).collect())
        }
    };
}

/// `agent`'s valid actions matching `filter`, oldest first: as the network's
/// authorities for them report it, or -- when they report nothing, as for an
/// agent on this same node, whose authority the network lookup skips --
/// what this node already holds, which it validated too.
pub fn agent_activity(agent: AgentPubKey, filter: ChainQueryFilter) -> ExternResult<Vec<(u32, ActionHash)>> {
    let network = get_agent_activity(agent.clone(), filter.clone(), ActivityRequest::Full, GetOptions::default())?.valid_activity;
    if !network.is_empty() {
        return Ok(network);
    }
    Ok(get_agent_activity(agent, filter, ActivityRequest::Full, GetOptions::local())?.valid_activity)
}

/// Lets any agent call `functions` of the calling zome on this device: a
/// zome-call grant with no constraint. What `send_remote_signal` needs to
/// reach `recv_remote_signal`, which Holochain refuses without a grant, and
/// what a giver's conductor needs to answer a typed handoff code. Returns
/// whether it wrote one (`ensure_grant`).
pub fn ensure_open_calls(tag: &str, functions: &[&str]) -> ExternResult<bool> {
    let zome = zome_info()?.name;
    let functions: GrantedFunctions = GrantedFunctions::Listed(functions.iter().map(|f| (zome.clone(), FunctionName::from(*f))).collect());
    ensure_grant(CapGrantEntry::new_zome_call_grant(tag.into(), GrantConstraint::Unrestricted, functions))
}

/// Lets any agent send this device direct signals -- app to app, with no
/// zome code on either end (chat and live location; see the app's
/// `holochain/live.ts`). Holochain drops a direct signal without one, even
/// one from this device's own agent. Returns whether it wrote one.
pub fn ensure_direct_signals(tag: &str) -> ExternResult<bool> {
    ensure_grant(CapGrantEntry::new_direct_signal_grant(tag.into(), GrantConstraint::Unrestricted))
}

/// Writes `grant` (privately) unless this device already holds it.
///
/// A grant's entry is private, so it lives only on the device that wrote
/// it: an account restored onto a new device from the network
/// (docs/RECOVERY.md) has the grant's action but not the grant. Each zome's
/// `prepare_device` ensures its grants on every start, so a device always
/// ends up holding its own.
fn ensure_grant(grant: CapGrantEntry) -> ExternResult<bool> {
    let held = chain::mine(&[EntryType::CapGrant]).creates().any(|record| matches!(record.entry().as_option(), Some(Entry::CapGrant(held)) if held == &grant))?;
    if held {
        return Ok(false);
    }
    create_cap_grant(grant)?;
    Ok(true)
}

/// Asks `function` of `zome` on this cell, and decodes its answer. The outer
/// error is the call itself failing -- the zome refusing, which carries its
/// reason -- or an answer that doesn't decode; the inner one, that it
/// couldn't be asked (unauthorized, say), as text. Each caller decides which
/// it can read past: a guard refuses on either, a best-effort read on
/// neither.
pub fn call_local<I, O>(zome: impl Into<ZomeName>, function: &str, input: I) -> ExternResult<Result<O, String>>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    answer(call(CallTargetCell::Local, zome.into(), function.into(), None, input)?)
}

/// `call_local`, of the app's `role` -- its previous network, say, whose
/// answers may not decode at all (it's another version).
pub fn call_role<I, O>(role: &str, zome: impl Into<ZomeName>, function: &str, input: I) -> ExternResult<Result<O, String>>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    answer(call(CallTargetCell::OtherRole(role.into()), zome.into(), function.into(), None, input)?)
}

// --- the bridge to the previous network ---

/// What one version of the network answers the next through its `previous`
/// role, beyond what every version has (docs/MIGRATION.md, "Across
/// versions"). Each names the calls that make it up; a version lists the
/// ones it has (account's `bridge_features`), and the next asks before it
/// relies on any.
pub mod bridge {
    /// Rewards carried over: rewards' `carried_balance` (with the gifts the
    /// member shows, asked by the owner or the key they moved to),
    /// `carried_gifts_of` and `store_line_of`, and the gifts an account seals
    /// to its next key as it leaves (`carry_my_gifts`).
    pub const REWARDS_CARRY: &str = "rewards-carry:v2";
    /// First-order deal cards, each claimed under a hash of its fingerprint
    /// salted with its store's line: dispatch's `newcomer_card_claim`,
    /// asked with the fingerprint by the same device's next version.
    pub const DEAL_CARDS: &str = "deal-cards:v3";
    /// Everything this version answers.
    pub const FEATURES: &[&str] = &[REWARDS_CARRY, DEAL_CARDS];
}

/// Whether this device is handing its account to a new phone (account's
/// `handing_over`): if so, it writes nothing of its own accord -- no
/// background work, no setup -- so the two can never both write as the
/// account and fork it. Taken as yes if it can't be told: waiting is
/// harmless, a fork isn't.
pub fn handing_over() -> bool {
    call(CallTargetCell::Local, ZomeName::from("account"), "handing_over".into(), None, ()).ok().and_then(|answer| match answer {
        ZomeCallResponse::Ok(io) => io.decode::<bool>().ok(),
        _ => None,
    }).unwrap_or(true)
}

/// What the app's previous network answered a call -- kept apart, as an app
/// must keep them apart: a network it doesn't carry, one that answered, one
/// it couldn't ask just now, and one that answered in a way it can't read.
#[derive(Debug, PartialEq, Eq)]
pub enum Previous<T> {
    /// The app carries no previous network (no `previous` role).
    NoNetwork,
    Answered(T),
    /// It couldn't be asked just now: try again.
    Unreachable(String),
    /// It answered, in a way this version can't read.
    Unreadable(String),
}

impl<T> Previous<T> {
    /// The answer -- `None` without a previous network -- or why it can't be
    /// had, for a person to read: to try again, or that the versions don't
    /// fit. Never a passing failure taken for an empty answer.
    pub fn or_retry(self) -> ExternResult<Option<T>> {
        match self {
            Previous::NoNetwork => Ok(None),
            Previous::Answered(answer) => Ok(Some(answer)),
            Previous::Unreachable(_) => Err(guest("The previous version of the network couldn't be reached just now. Try again in a moment.")),
            Previous::Unreadable(_) => Err(guest("The previous version of the network answered in a way this version can't read.")),
        }
    }
}

/// Whether a failed call's error is Holochain saying the app has no cell
/// for the role it named -- one that doesn't carry it at all.
fn no_such_role(error: &str) -> bool {
    let error = error.to_lowercase();
    error.contains("role") && (error.contains("not found") || error.contains("no cell") || error.contains("missing") || error.contains("unknown") || error.contains("doesn't exist") || error.contains("does not exist"))
}

/// `previous`'s answer to `function` in `zome`, kept apart as `Previous`
/// says.
pub fn ask_previous<I, O>(zome: &str, function: &str, input: I) -> Previous<O>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    read_previous(call(CallTargetCell::OtherRole("previous".into()), ZomeName::from(zome), function.into(), None, input))
}

/// A call's outcome, as `ask_previous` reads it.
pub fn read_previous<O: for<'de> Deserialize<'de> + std::fmt::Debug>(answer: ExternResult<ZomeCallResponse>) -> Previous<O> {
    match answer {
        Ok(ZomeCallResponse::Ok(io)) => match io.decode::<O>() {
            Ok(decoded) => Previous::Answered(decoded),
            Err(e) => Previous::Unreadable(format!("{e:?}")),
        },
        Ok(other) => Previous::Unreachable(format!("{other:?}")),
        Err(e) if no_such_role(&format!("{e:?}")) => Previous::NoNetwork,
        Err(e) => Previous::Unreachable(format!("{e:?}")),
    }
}

/// What asking the previous network for its bridge features came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Asked {
    /// It listed them.
    Answered(Vec<String>),
    /// It has no such function: a version from before they were listed.
    Missing,
    /// It couldn't be asked, or failed answering: try again later.
    Failed(String),
}

/// Whether a failed call's error is Holochain saying the function asked for
/// doesn't exist in the zome -- an older version's, not a passing failure.
fn missing_function(error: &str) -> bool {
    error.contains("ZomeFnNotExists") || error.contains("doesn't exist") || error.contains("does not exist")
}

/// `bridge_features`' answer, as `previous_answers` reads it: only a call
/// Holochain refused for want of the function is an older version; every
/// other failure is passing.
pub fn asked(answer: ExternResult<ZomeCallResponse>) -> Asked {
    match answer {
        Ok(ZomeCallResponse::Ok(io)) => match io.decode::<Vec<String>>() {
            Ok(features) => Asked::Answered(features),
            Err(e) => Asked::Failed(format!("its features didn't decode: {e:?}")),
        },
        Ok(other) => Asked::Failed(format!("{other:?}")),
        Err(e) if missing_function(&format!("{e:?}")) => Asked::Missing,
        Err(e) => Asked::Failed(format!("{e:?}")),
    }
}

/// Whether the previous network answers `feature` (`bridge`): `Ok(true)` or
/// `Ok(false)` -- false from a version too old to list what it answers,
/// which never changes -- or `Err` if it can't be asked just now, to try
/// again later. Only Holochain's word that the list doesn't exist there
/// counts as too old; any other failure is tried again, never taken for it.
pub fn previous_answers(feature: &str) -> ExternResult<Result<bool, String>> {
    let previous = || CallTargetCell::OtherRole("previous".into());
    match asked(call(previous(), ZomeName::from("account"), "bridge_features".into(), None, ())) {
        Asked::Answered(features) => Ok(Ok(features.iter().any(|f| f == feature))),
        Asked::Failed(why) => Ok(Err(why)),
        // An older version -- if it's the previous network answering what
        // every version does.
        Asked::Missing => match call(previous(), ZomeName::from("account"), "network_hash".into(), None, ()) {
            Ok(ZomeCallResponse::Ok(_)) => Ok(Ok(false)),
            Ok(other) => Ok(Err(format!("{other:?}"))),
            Err(e) => Ok(Err(format!("{e:?}"))),
        },
    }
}


/// `call_local`, of `agent`'s own node, over the network -- the inner error
/// when it can't be reached.
pub fn call_agent<I, O>(agent: AgentPubKey, zome: impl Into<ZomeName>, function: &str, input: I) -> ExternResult<Result<O, String>>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    answer(call_remote(agent, zome.into(), function.into(), None, input)?)
}

fn answer<O: for<'de> Deserialize<'de> + std::fmt::Debug>(response: ZomeCallResponse) -> ExternResult<Result<O, String>> {
    match response {
        ZomeCallResponse::Ok(io) => Ok(Ok(io.decode().map_err(|e| wasm_error!(e))?)),
        ZomeCallResponse::NetworkError(message) => Ok(Err(message)),
        other => Ok(Err(format!("{other:?}"))),
    }
}

/// Calls `function`, one of the calling zome's own externs, in a call of its
/// own, and decodes its answer -- `None` if it failed. For a background
/// sweep over many orders: a zome call commits all its writes or none, so
/// one item's write that doesn't validate (yet) would otherwise undo every
/// other item's, every run, until that one resolves. Each item is its own
/// call; one failing only skips it until the next run.
pub fn isolated<I, O>(function: &str, input: I) -> Option<O>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    call_local(zome_info().ok()?.name, function, input).ok()?.ok()
}

#[cfg(test)]
mod bridge_tests {
    use super::*;

    fn host_error(message: &str) -> ExternResult<ZomeCallResponse> {
        Err(wasm_error!(WasmErrorInner::Host(message.into())))
    }

    #[test]
    fn only_a_missing_function_is_an_older_version() {
        assert_eq!(asked(host_error("RibosomeError(ZomeFnNotExists(ZomeName(\"account\"), FunctionName(\"bridge_features\")))")), Asked::Missing);
        assert_eq!(asked(host_error("Attempted to call a zome function that doesn't exist: account bridge_features")), Asked::Missing);
    }

    #[test]
    fn a_passing_failure_is_tried_again_never_taken_for_an_older_version() {
        assert!(matches!(asked(Ok(ZomeCallResponse::NetworkError("timed out".into()))), Asked::Failed(_)));
        assert!(matches!(asked(Ok(ZomeCallResponse::CountersigningSession("a session is open".into()))), Asked::Failed(_)));
        assert!(matches!(asked(host_error("the conductor is shutting down")), Asked::Failed(_)));
        assert!(matches!(asked(host_error("database is locked")), Asked::Failed(_)));
    }

    #[test]
    fn a_previous_network_answering_unreachable_missing_or_unreadable_are_kept_apart() {
        let io = ExternIO::encode(7u32).unwrap();
        assert_eq!(read_previous::<u32>(Ok(ZomeCallResponse::Ok(io))), Previous::Answered(7));
        assert!(matches!(read_previous::<u32>(Ok(ZomeCallResponse::NetworkError("timed out".into()))), Previous::Unreachable(_)));
        assert!(matches!(read_previous::<u32>(host_error("database is locked")), Previous::Unreachable(_)));
        assert!(matches!(read_previous::<u32>(host_error("CellMissing: no cell for role previous")), Previous::NoNetwork));
        let wrong = ExternIO::encode("not a number").unwrap();
        assert!(matches!(read_previous::<u32>(Ok(ZomeCallResponse::Ok(wrong))), Previous::Unreadable(_)));
        assert!(Previous::<u32>::Unreachable("x".into()).or_retry().is_err(), "never taken for an empty answer");
        assert_eq!(Previous::<u32>::NoNetwork.or_retry().unwrap(), None);
    }

    #[test]
    fn a_list_is_read() {
        let io = ExternIO::encode(vec!["rewards-carry:v2".to_string()]).unwrap();
        assert_eq!(asked(Ok(ZomeCallResponse::Ok(io))), Asked::Answered(vec!["rewards-carry:v2".into()]));
    }
}
