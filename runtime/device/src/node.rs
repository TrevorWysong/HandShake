//! The account's app on the device's conductor, over its admin interface:
//! installing it for a key, restoring it from the network, and stopping it
//! -- for a while, or for good.

use crate::{Error, Result};
use holochain_client::{AdminWebsocket, AppInfo, InstallAppPayload};
use holochain_types::app::{AppBundleSource, AppStatus, RoleSettingsMap};
use holochain_types::prelude::AgentPubKey;
use std::time::Duration;

/// The app a runtime runs, as it installs it.
#[derive(Clone)]
pub struct App {
    pub installed_app_id: String,
    pub bundle: AppBundleSource,
    /// The network's settings (its DNA properties), when the bundle doesn't
    /// carry them itself.
    pub roles_settings: Option<RoleSettingsMap>,
}

/// How often a restore's progress is looked at.
const RESTORE_POLL: Duration = Duration::from_secs(1);

fn conductor(err: impl std::fmt::Debug) -> Error {
    Error::Conductor(format!("{err:?}"))
}

pub async fn app_info(admin: &AdminWebsocket, app: &App) -> Result<Option<AppInfo>> {
    Ok(admin.list_apps(None).await.map_err(conductor)?.into_iter().find(|info| info.installed_app_id == app.installed_app_id))
}

async fn install(admin: &AdminWebsocket, app: &App, agent: &AgentPubKey, restore_from_dht: bool) -> Result<()> {
    admin
        .install_app(InstallAppPayload {
            source: app.bundle.clone(),
            agent_key: Some(agent.clone()),
            installed_app_id: Some(app.installed_app_id.clone()),
            network_seed: None,
            roles_settings: app.roles_settings.clone(),
            ignore_genesis_failure: false,
            restore_from_dht,
        })
        .await
        .map_err(conductor)?;
    Ok(())
}

/// A first install, for a new account's key.
pub async fn install_new(admin: &AdminWebsocket, app: &App, agent: &AgentPubKey) -> Result<()> {
    install(admin, app, agent, false).await?;
    admin.enable_app(app.installed_app_id.clone()).await.map_err(conductor)?;
    Ok(())
}

/// The app for `agent`, its chain rebuilt from the network, then enabled.
/// An install for any other key goes first (the one a new phone started
/// with). Picks up a restore already under way, and waits up to `patience`
/// for it -- the account's history has to be reachable on the network.
pub async fn restore(admin: &AdminWebsocket, app: &App, agent: &AgentPubKey, patience: Duration) -> Result<()> {
    match app_info(admin, app).await? {
        Some(info) if info.agent_pub_key == *agent => {}
        Some(_) => {
            retire(admin, app).await?;
            install(admin, app, agent, true).await?;
        }
        None => install(admin, app, agent, true).await?,
    }
    let started = tokio::time::Instant::now();
    loop {
        let info = app_info(admin, app).await?.ok_or_else(|| Error::Conductor("the app disappeared while restoring".into()))?;
        match info.status {
            AppStatus::AwaitingRestore if started.elapsed() < patience => tokio::time::sleep(RESTORE_POLL).await,
            AppStatus::AwaitingRestore => return Err(Error::StillRestoring),
            AppStatus::Unrecoverable(_, reason) => return Err(Error::Unrecoverable(format!("{reason:?}"))),
            AppStatus::Enabled => return Ok(()),
            AppStatus::Disabled(_) | AppStatus::AwaitingMemproofs => {
                admin.enable_app(app.installed_app_id.clone()).await.map_err(conductor)?;
                return Ok(());
            }
        }
    }
}

/// Stops the app writing anything -- its zome calls, background work and
/// answers to other devices -- until `thaw`.
pub async fn freeze(admin: &AdminWebsocket, app: &App) -> Result<()> {
    admin.disable_app(app.installed_app_id.clone()).await.map_err(conductor)
}

pub async fn thaw(admin: &AdminWebsocket, app: &App) -> Result<()> {
    admin.enable_app(app.installed_app_id.clone()).await.map_err(conductor)?;
    Ok(())
}

/// Removes the app, and with it this device's copy of the account.
pub async fn retire(admin: &AdminWebsocket, app: &App) -> Result<()> {
    admin.uninstall_app(app.installed_app_id.clone(), false).await.map_err(conductor)
}

/// Calls `function` in `zome` of the app's relay cell as the account itself:
/// signed with its key, straight from the keystore. A call signed by a
/// cell's own agent needs no grant, so -- unlike a client given signing
/// credentials, whose grant is a write on the account's chain -- this writes
/// nothing before the call does. What the handover's checks need: asked
/// before this device has written anything as the account. The zome's
/// refusal comes back as `Ok(Err(why))`.
pub async fn call_as_account<I: serde::Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(
    admin: &AdminWebsocket,
    lair: &lair_keystore_api::LairClient,
    app: &App,
    zome: &str,
    function: &str,
    input: I,
) -> Result<std::result::Result<O, String>> {
    use holochain_client::{AllowedOrigins, AppWebsocket, CellInfo, ExternIO, IssueAppAuthenticationTokenPayload, LairAgentSigner, ZomeCallTarget};
    let info = app_info(admin, app).await?.ok_or(Error::NoSuchKey)?;
    let Some(CellInfo::Provisioned(cell)) = info.cell_info.get("handshake").and_then(|cells| cells.first()) else { return Err(Error::Conductor("the app has no relay cell".into())) };
    let mut signer = LairAgentSigner::new(std::sync::Arc::new(lair.clone()));
    signer.add_credentials(cell.cell_id.clone(), info.agent_pub_key.clone());
    let port = admin.attach_app_interface(0, None, AllowedOrigins::Any, Some(info.installed_app_id.clone())).await.map_err(conductor)?;
    let token = admin.issue_app_auth_token(IssueAppAuthenticationTokenPayload::for_installed_app_id(info.installed_app_id.clone())).await.map_err(conductor)?.token;
    let ws = AppWebsocket::connect(("127.0.0.1", port), token, std::sync::Arc::new(signer), None).await.map_err(conductor)?;
    let payload = ExternIO::encode(input).map_err(conductor)?;
    Ok(match ws.call_zome(ZomeCallTarget::CellId(cell.cell_id.clone()), zome.into(), function.into(), payload).await {
        Ok(answer) => Ok(answer.decode::<O>().map_err(conductor)?),
        Err(err) => Err(format!("{err:?}")),
    })
}
