//! An account moving between real conductors, each with its own keystore,
//! through `Device` exactly as a runtime would drive it: the new device
//! invites, the old one sends its key and stops, the new one takes the key
//! in and restores the account from the network -- held, while the old
//! device is stopped, by two more nodes: Holochain restores only a chain
//! head at least two peers agree on (`restore_chain_quorum`).
//!
//! Needs Holochain 0.7.1's binaries on PATH and the packed bundle
//! (workdir/handshake.happ, `npm run backend`). Run with
//! `cargo test --manifest-path runtime/device/Cargo.toml -- --ignored`.

use holochain_client::{AdminWebsocket, AllowedOrigins, AppWebsocket, AuthorizeSigningCredentialsPayload, CellInfo, ClientAgentSigner, ExternIO, IssueAppAuthenticationTokenPayload, ZomeCallTarget};
use holochain_types::app::{AppBundleSource, AppStatus};
use holochain_types::prelude::{ActionHash, ActionHashB64, AgentPubKey};
use lair_keystore_api::dependencies::{sodoken, url::Url};
use lair_keystore_api::ipc_keystore::ipc_keystore_connect;
use handshake_device::node::{app_info, App};
use handshake_device::{Device, Error};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

const PASSPHRASE: &str = "lair-password";

fn app() -> App {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../workdir/handshake.happ");
    assert!(bundle.exists(), "pack the bundle first: npm run backend (in web/)");
    App { installed_app_id: "handshake".into(), bundle: AppBundleSource::Path(bundle), roles_settings: None }
}

/// The first line of `child`'s stdout containing `marker`, from there on.
async fn line_after(child: &mut Child, marker: &str) -> String {
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        if let Some(at) = line.find(marker) {
            let rest = line[at + marker.len()..].to_string();
            // Keep draining, so the process never blocks on a full pipe.
            tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
            return rest;
        }
    }
    panic!("no {marker} from the process");
}

/// The network's bootstrap and relay server.
async fn services() -> (Child, String) {
    let mut child = Command::new("kitsune2-bootstrap-srv").stdout(Stdio::piped()).kill_on_drop(true).spawn().expect("kitsune2-bootstrap-srv on PATH");
    let address = line_after(&mut child, "#kitsune2_bootstrap_srv#listening#").await;
    (child, format!("http://{}", address.split('#').next().unwrap()))
}

/// One device: a sandbox conductor with its keystore in process, as a
/// runtime embeds them.
struct Node {
    _dir: tempfile::TempDir,
    _conductor: Child,
    device: Device,
    admin: AdminWebsocket,
    /// The app's connection, for the install it was made for.
    app_ws: tokio::sync::Mutex<Option<(holochain_types::prelude::CellId, AppWebsocket)>>,
}

async fn node(services: &str) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let mut create = Command::new("hc")
        .args(["sandbox", "--piped", "create", "--root"])
        .arg(dir.path())
        .args(["--in-process-lair", "network", "--bootstrap", services, "quic", services])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("hc on PATH");
    create.stdin.take().unwrap().write_all(format!("{PASSPHRASE}\n").as_bytes()).await.unwrap();
    let out = create.wait_with_output().await.unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let root = PathBuf::from(text.split("DataRootPath(\"").nth(1).and_then(|r| r.split('"').next()).expect("the sandbox's directory"));
    let config_path = root.join("conductor-config.yaml");
    let config = std::fs::read_to_string(&config_path).unwrap();
    // Fast gossip, as tryorama sets it, so the witness holds the old
    // device's chain in seconds.
    let lair_root = PathBuf::from(config.lines().find_map(|l| l.trim().strip_prefix("lair_root:")).expect("an in-process keystore").trim());
    let config = config.replace("  advanced:\n", "  advanced:\n    k2Gossip:\n      initiateIntervalMs: 1000\n      minInitiateIntervalMs: 1000\n      initiateJitterMs: 100\n      roundTimeoutMs: 5000\n");
    std::fs::write(&config_path, config).unwrap();

    let mut conductor = Command::new("holochain").arg("--piped").arg("-c").arg(&config_path).stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn().expect("holochain on PATH");
    conductor.stdin.take().unwrap().write_all(format!("{PASSPHRASE}\n").as_bytes()).await.unwrap();
    let port: u16 = line_after(&mut conductor, "###ADMIN_PORT:").await.split("###").next().unwrap().parse().unwrap();
    let admin = AdminWebsocket::connect(("127.0.0.1", port), None).await.unwrap();

    let lair_config = std::fs::read_to_string(lair_root.join("lair-keystore-config.yaml")).unwrap();
    let url = lair_config.lines().find_map(|l| l.trim().strip_prefix("connectionUrl:")).unwrap().trim().to_string();
    let passphrase = Arc::new(Mutex::new(sodoken::LockedArray::from(PASSPHRASE.as_bytes().to_vec())));
    let lair = ipc_keystore_connect(Url::parse(&url).unwrap(), passphrase).await.unwrap();
    let device = Device::new(lair, AdminWebsocket::connect(("127.0.0.1", port), None).await.unwrap(), app());
    Node { _dir: dir, _conductor: conductor, device, admin, app_ws: tokio::sync::Mutex::new(None) }
}

/// Everyone knows everyone, rather than waiting on bootstrap.
async fn introduce(nodes: &[&Node]) {
    let mut infos = Vec::new();
    for node in nodes {
        infos.extend(node.admin.agent_info(None).await.unwrap());
    }
    for node in nodes {
        node.admin.add_agent_info(infos.clone()).await.unwrap();
    }
}

/// A zome call to `node`'s app, as its UI would make it: the answer, or the
/// zome's refusal as text.
/// Connected once per install of the app -- each authorization of signing
/// credentials writes a grant to the account's chain, so a connection made
/// per call would grow the chain as fast as anyone polled it.
async fn app_ws(node: &Node) -> AppWebsocket {
    let info = app_info(&node.admin, &app()).await.unwrap().unwrap();
    let Some(CellInfo::Provisioned(cell)) = info.cell_info["handshake"].first() else { panic!("no relay cell") };
    let mut cached = node.app_ws.lock().await;
    if let Some((cell_id, ws)) = cached.as_ref() {
        if cell_id == &cell.cell_id {
            return ws.clone();
        }
    }
    let signer = ClientAgentSigner::default();
    let credentials = node.admin.authorize_signing_credentials(AuthorizeSigningCredentialsPayload { cell_id: cell.cell_id.clone(), functions: None }).await.unwrap();
    signer.add_credentials(cell.cell_id.clone(), credentials);
    let port = node.admin.attach_app_interface(0, None, AllowedOrigins::Any, None).await.unwrap();
    let token = node.admin.issue_app_auth_token(IssueAppAuthenticationTokenPayload::for_installed_app_id(info.installed_app_id.clone())).await.unwrap().token;
    let ws = AppWebsocket::connect(("127.0.0.1", port), token, signer.into(), None).await.unwrap();
    *cached = Some((cell.cell_id.clone(), ws.clone()));
    ws
}

async fn call<I: serde::Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(node: &Node, zome: &str, function: &str, input: I) -> Result<O, String> {
    let app_ws = app_ws(node).await;
    match app_ws.call_zome(ZomeCallTarget::RoleName("handshake".into()), zome.into(), function.into(), ExternIO::encode(input).unwrap()).await {
        Ok(answer) => Ok(answer.decode::<O>().unwrap()),
        Err(err) => Err(format!("{err:?}")),
    }
}

/// What the old phone's app checks before it sends its key: the network
/// holds everything this device wrote (the account zome's `ready_to_move`)
/// -- its handover mark too.
#[track_caller]
fn wait_until_ready(node: &Node) -> impl std::future::Future<Output = ActionHash> + '_ {
    let caller = std::panic::Location::caller();
    async move { ready_or_panic(node, caller).await }
}

async fn ready_or_panic(node: &Node, caller: &'static std::panic::Location<'static>) -> ActionHash {
    #[derive(Debug, serde::Deserialize)]
    struct Readiness {
        head: ActionHash,
        seq: u32,
        seen: Option<u32>,
        ready: bool,
    }
    for _ in 0..120 {
        let readiness: Readiness = call(node, "account", "ready_to_move", ()).await.unwrap();
        if readiness.ready {
            return readiness.head;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let last: Readiness = call(node, "account", "ready_to_move", ()).await.unwrap();
    panic!("the network never held the device's chain (waited at {caller}): at {} the device, the network saw {:?}", last.seq, last.seen);
}

/// The old phone's app, about to send its key: marks the handover, and
/// waits until the network holds the mark -- the head the new phone checks.
async fn hand_over(node: &Node) -> String {
    let marked: ActionHash = call(node, "account", "begin_handover", ()).await.unwrap();
    assert_eq!(wait_until_ready(node).await, marked, "the chain ends at the mark");
    ActionHashB64::from(marked).to_string()
}


/// The new phone receiving `sealed`, however long its restore takes, and
/// however long the network takes to say the handover stands.
async fn receive(node: &Node, sealed: &str) -> handshake_device::Result<AgentPubKey> {
    let mut tries = 0;
    loop {
        match node.device.receive(sealed).await {
            Err(Error::StillRestoring | Error::NotYet) if tries < 20 => {
                tries += 1;
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            answer => return answer,
        }
    }
}

async fn status(node: &Node) -> Option<AppStatus> {
    app_info(&node.admin, &app()).await.unwrap().map(|info| info.status)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Holochain's binaries and the packed bundle"]
async fn an_account_moves_to_a_new_device_with_its_key() {
    let (_services, url) = services().await;
    let (old, witness, second_witness, new) = (node(&url).await, node(&url).await, node(&url).await, node(&url).await);
    let account = old.device.start_account().await.unwrap();
    assert_eq!(old.device.start_account().await.unwrap(), account, "a second start is the same account");
    witness.device.start_account().await.unwrap();
    second_witness.device.start_account().await.unwrap();
    // The new phone opens HandShake for the first time: an account of its own,
    // which the move replaces.
    let throwaway = new.device.start_account().await.unwrap();
    assert!(old.device.can_move().await.unwrap());
    introduce(&[&old, &witness, &second_witness, &new]).await;
    wait_until_ready(&old).await;

    // ===== Taken back before the new phone used it =====
    let invitation = new.device.invite().await.unwrap();
    let head = hand_over(&old).await;
    assert!(matches!(old.device.send("handshake-move:1:nonsense", &head).await, Err(Error::BadCode)));
    assert_eq!(status(&old).await, Some(AppStatus::Enabled), "a bad code changes nothing");
    let stale = old.device.send(&invitation, &head).await.unwrap();
    assert!(matches!(status(&old).await, Some(AppStatus::Disabled(_))), "the old device stops writing");
    old.device.stay().await.expect("the new phone never used it: taken back");
    assert_eq!(status(&old).await, Some(AppStatus::Enabled), "and the old device runs again");
    wait_until_ready(&old).await;
    // The new phone scans the code it was shown anyway: it restores the
    // account, finds -- before writing anything -- the old phone took it
    // back, and lets it go.
    assert!(matches!(receive(&new, &stale).await, Err(Error::TakenBack)), "the new phone refuses an account taken back");
    assert_eq!(status(&new).await, None, "and keeps nothing of it");
    println!("[PASS] taken back before the new phone used it; the new phone then refuses it, having written nothing");

    // ===== Moved, then too late to take back =====
    let invitation = new.device.invite().await.unwrap();
    let head = hand_over(&old).await;
    let sealed = old.device.send(&invitation, &head).await.unwrap();
    let moved = receive(&new, &sealed).await.unwrap();
    assert_eq!(moved, account);
    let info = app_info(&new.admin, &app()).await.unwrap().unwrap();
    assert_eq!(info.agent_pub_key, account, "the new device runs the account, not its own first key");
    assert_ne!(info.agent_pub_key, throwaway);
    assert_eq!(info.status, AppStatus::Enabled);
    assert!(new.device.can_move().await.unwrap(), "and can move it on again");
    assert_eq!(new.device.receive(&sealed).await.unwrap(), account, "safe to repeat");
    // Confirmed as it was received: the new phone carries on as the account,
    // and writes.
    call::<_, ()>(&new, "dispatch", "prepare_device", ()).await.unwrap();
    wait_until_ready(&new).await;
    // Now the old phone tries to take it back: refused, never two writers.
    assert!(matches!(old.device.stay().await, Err(Error::TooLate)), "the old phone can't take back what the new phone uses");
    assert!(matches!(status(&old).await, Some(AppStatus::Disabled(_))), "and stops again: never two writers");
    println!("[PASS] once the new phone writes as the account, the old phone can't take it back");

    old.device.retire().await.unwrap();
    assert_eq!(status(&old).await, None, "the old device keeps nothing");
}
