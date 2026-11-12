// "I already have an account": bringing an existing account onto this
// device.
//
//   - From their other phone, which still works: it sends the account's own
//     key here, sealed, and this device restores the account from the
//     network -- the same account, nothing to confirm (`FromDevice`).
//   - From the previous version of the network (docs/MIGRATION.md).
//   - Recovering a lost phone's account onto this device's key, with the
//     recovery phrase, which signs for this key, or guardians, who scan its
//     code and vouch. The person then confirms their details.
//
// For a migration or a recovery, this device's key is made (and, in
// development, remembered) first, so the code it shows stays the same
// across reloads -- guardians may take days. Waiting is polled, not
// pushed: nothing tells a new device it's been vouched for.
import { wait } from "../../lib/network/retry";
import { useState } from "react";
import { ArrowLeft, HeartHandshake, History, KeyRound, Smartphone } from "lucide-react";
import type { AgentPubKey, PlanView, VouchView } from "../../holochain/types";
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import { accountsForPhraseKey, arrive, arrivedFrom, latestActionOf, migrationsToMeOnPrevious, mySuccession, recoveryPlanOf, takeOver, vouchesForMe } from "../../holochain/zomes/account";
import { hasPreviousNetwork, thisNetwork } from "../../holochain/client";
import { canReceiveAccount, deviceRuntime } from "../../holochain/device";
import { invitationFingerprint, sealedAccount, sealedHead } from "../../lib/account/deviceMove";
import { encodeHashToBase64 } from "@holochain/client";
import { useArrival } from "../../store/arrival";
import { catalogsOf, importStore, moveStore, previousStores } from "../../holochain/zomes/catalog";
import { AccountCode, CodeCard, CodeReader, MoveCode } from "./AccountCode";
import { Button, Field, Input, Notice, Skeleton, Spinner, Textarea } from "../ui";
import { adoptPredecessor, keyFingerprint, readPredecessor, type AccountPlace } from "../../lib/account/accountMove";
import { describeError } from "../../lib/ui/errors";
import { phraseKey, phraseMessage, readPhrase } from "../../lib/account/recoveryPhrase";
import { POLL } from "../../lib/network/poll";
import { usePolling, useResource } from "../../lib/hooks/useResource";
import { useSession } from "../../store/session";
import { remember, rememberedMethod, type Method } from "../../lib/account/restoring";
import { t as translate, useT } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";


export function RestoreAccount({ devAdminUrl, onBack, onDone }: { devAdminUrl: string; onBack: () => void; onDone: () => void }) {
  const { agentPubKey, prepareNewDevice } = useSession();
  const t = useT();
  const [method, setMethod] = useState<Method | null>(() => {
    const remembered = rememberedMethod();
    return remembered === "device" || agentPubKey ? remembered : null;
  });
  const { data: canReceive } = useResource("can-receive-account", canReceiveAccount);
  const preparing = useAction();
  // A key that already took an account over (a reload mid-way) goes
  // straight to confirming the details.
  const { data: taken } = useResource(agentPubKey && `succession:${bytesToHex(agentPubKey)}`, mySuccession);
  // A release that carries the previous version of the network offers to
  // bring an account over from it (docs/MIGRATION.md) -- and, after a reload
  // mid-way, picks up where it was.
  // Asked again until it can be told: a check that failed isn't "none".
  const { data: hasPrevious } = useResource(agentPubKey && `has-previous:${bytesToHex(agentPubKey)}`, hasPreviousNetwork, { pollMs: POLL.slow });
  const { data: arrived } = useResource(agentPubKey && hasPrevious ? `arrived:${bytesToHex(agentPubKey)}` : null, () => arrivedFrom(agentPubKey!));
  const [predecessor, setPredecessor] = useState<AgentPubKey | null>(null);
  const takenOver = predecessor ?? taken?.predecessor ?? arrived ?? null;
  const place: AccountPlace = method === "previous" || (!!arrived && !taken) ? "previous" : "here";

  function choose(next: Method) {
    preparing.setError(null);
    // The account comes with its own key: this device needs none of its own.
    if (next === "device") {
      remember(next);
      setMethod(next);
      return;
    }
    return preparing.run(async () => {
      await prepareNewDevice(devAdminUrl);
      remember(next);
      setMethod(next);
    });
  }

  if (takenOver && agentPubKey) {
    return (
      <ConfirmDetails
        predecessor={takenOver}
        place={place}
        recovered={place === "here"}
        onDone={() => {
          remember(null);
          onDone();
        }}
      />
    );
  }

  const back = method
    ? () => {
        remember(null);
        setMethod(null);
      }
    : onBack;

  return (
    <div>
      <button type="button" onClick={back} className="mb-3 flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-ink-700">
        <ArrowLeft size={14} /> {t("common.back")}
      </button>
      {method === "device" ? (
        <FromDevice />
      ) : !method || !agentPubKey ? (
        <>
          <h2 className="mb-1 text-lg font-bold">{t("restore.title")}</h2>
          <p className="mb-4 text-sm text-ink-500">{t("restore.subtitle")}</p>
          <div className="flex flex-col gap-2">
            {hasPrevious && (
              <MethodCard icon={<History size={18} />} title={t("restore.previous")} blurb={t("restore.previousBlurb")} onClick={() => choose("previous")} disabled={preparing.busy} />
            )}
            {canReceive && <MethodCard icon={<Smartphone size={18} />} title={t("restore.device")} blurb={t("restore.deviceBlurb")} onClick={() => choose("device")} disabled={preparing.busy} />}
            <MethodCard icon={<KeyRound size={18} />} title={t("restore.phrase")} blurb={t("restore.phraseBlurb")} onClick={() => choose("phrase")} disabled={preparing.busy} />
            <MethodCard icon={<HeartHandshake size={18} />} title={t("restore.guardians")} blurb={t("restore.guardiansBlurb")} onClick={() => choose("guardians")} disabled={preparing.busy} />
          </div>
          {preparing.busy && (
            <p className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-500">
              <Spinner className="h-3 w-3" /> {t("restore.settingUp")}
            </p>
          )}
          {preparing.error && <Notice className="mt-3">{preparing.error}</Notice>}
        </>
      ) : method === "previous" ? (
        <FromPreviousVersion me={agentPubKey} onTaken={setPredecessor} />
      ) : method === "phrase" ? (
        <FromPhrase me={agentPubKey} onTaken={setPredecessor} />
      ) : (
        <FromGuardians me={agentPubKey} onTaken={setPredecessor} />
      )}
    </div>
  );
}

function MethodCard({ icon, title, blurb, onClick, disabled }: { icon: React.ReactNode; title: string; blurb: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex items-center gap-3 rounded-xl border-2 border-ink-100 p-3 text-left transition hover:border-ink-200 disabled:opacity-60">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500">{icon}</span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-ink-500">{blurb}</span>
      </span>
    </button>
  );
}

/// This phone's side of receiving the account from the person's other one,
/// with its key (docs/RECOVERY.md): it shows an invitation, scans the key the
/// other phone seals to it, and restores the account from the network --
/// the very same account, so there are no details to confirm. The app then
/// starts again as it.
function FromDevice() {
  const t = useT();
  const { data: invitation, error: inviteError } = useResource("move-invitation", async () => {
    const runtime = await deviceRuntime();
    if (!runtime) throw new Error(t("move.unsupported"));
    return runtime.invite();
  });
  const [scanning, setScanning] = useState(false);
  const [sealed, setSealed] = useState<string | null>(null);
  // The app starts again with the account: it stays busy as it does.
  const receiving = useAction();

  function receive(code: string) {
    setSealed(code);
    return receiving.run(async () => {
      const runtime = (await deviceRuntime())!;
      await runtime.receive(code);
      remember(null);
      // A runtime checked the handover as it received it. On one node (the
      // dev host) the app does, as it starts as the account (`Arrival`).
      const head = sealedHead(code);
      if (head && runtime.oneNode) useArrival.getState().arrive(encodeHashToBase64(head));
      window.location.reload();
    }, { stayBusy: true });
  }

  if (sealed) {
    return (
      <>
        <h2 className="mb-1 text-lg font-bold">{t("receive.bringingTitle")}</h2>
        <p className="mb-4 text-sm text-ink-500">{t("receive.bringing")}</p>
        {receiving.error ? (
          <>
            <Notice className="mb-3">{receiving.error}</Notice>
            <Button className="w-full" loading={receiving.busy} onClick={() => receive(sealed)}>
              {t("receive.tryAgain")}
            </Button>
          </>
        ) : (
          <p className="flex items-center justify-center gap-2 text-xs text-ink-400">
            <Spinner className="h-3 w-3" /> {t("receive.waiting")}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">{scanning ? t("receive.scan") : t("receive.title")}</h2>
      <p className="mb-4 text-sm text-ink-500">{scanning ? t("receive.scanHow") : t("receive.how")}</p>
      {scanning ? (
        <CodeReader accepts={(code) => sealedAccount(code) !== null} onCode={receive} prompt={t("receive.point")} refusal={t("receive.notSealed")} placeholder="handshake-key:1:…" />
      ) : invitation ? (
        <>
          <CodeCard code={invitation} fingerprint={invitationFingerprint(invitation)} note={t("receive.note")} />
          <Button className="mt-4 w-full" onClick={() => setScanning(true)}>
            {t("receive.next")}
          </Button>
        </>
      ) : inviteError ? (
        <Notice>{describeError(inviteError)}</Notice>
      ) : (
        <Skeleton className="mx-auto h-56 w-56" />
      )}
    </>
  );
}

/// Waits for the previous version of the app to move the account here, then
/// records the arrival (docs/MIGRATION.md).
function FromPreviousVersion({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const t = useT();
  const { data: network } = useResource("this-network", thisNetwork);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  usePolling(
    async () => {
      try {
        const moved = (await migrationsToMeOnPrevious()).find((m) => m.close);
        if (!moved) return;
        const account = await arrive();
        setDone(true);
        onTaken(account);
      } catch (err) {
        setError(describeError(err));
      }
    },
    { pollMs: POLL.waitingDevice, background: true },
    !done,
  );
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">{t("restore.fromPrevious")}</h2>
      <p className="mb-4 text-sm text-ink-500">{t("restore.fromPreviousHow")}</p>
      {network ? <MoveCode network={network} agent={me} note={t("restore.fromPreviousNote")} /> : <Skeleton className="mx-auto h-56 w-56" />}
      <p className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-400">
        <Spinner className="h-3 w-3" /> {t("restore.waitingPrevious")}
      </p>
      {error && <Notice className="mt-3">{error}</Notice>}
    </>
  );
}

/// The recovery phrase, typed in: finds the account it recovers and signs
/// for this key.
function FromPhrase({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const recovering = useAction();

  // Taking the account over moves on from here: it stays busy until it does.
  function recover() {
    const phrase = readPhrase(text);
    if (!phrase) return recovering.setError(t("restore.notPhrase"));
    return recovering.run(async () => {
      const key = phraseKey(phrase);
      const [account]: PlanView[] = await accountsForPhraseKey(key.publicKey);
      if (!account) throw new Error(t("restore.noAccount"));
      const head = await whereItStands(account.account);
      await takeOver({ predecessor: account.account, authority: { Phrase: { plan: account.plan, head, signature: key.sign(phraseMessage(account.account, me, head)) } } });
      onTaken(account.account);
    }, { stayBusy: true });
  }

  return (
    <>
      <h2 className="mb-1 text-lg font-bold">{t("restore.phraseTitle")}</h2>
      <p className="mb-4 text-sm text-ink-500">{t("restore.phraseDetail")}</p>
      <Textarea rows={4} autoCapitalize="none" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("restore.phrasePlaceholder")} className="font-mono" />
      {recovering.error && <Notice className="mt-3">{recovering.error}</Notice>}
      <Button className="mt-4 w-full" loading={recovering.busy} disabled={!text.trim()} onClick={recover}>
        {t("restore.recover")}
      </Button>
    </>
  );
}

/// Shows this device's code to guardians, and takes the account over once
/// enough of them have vouched.
function FromGuardians({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const t = useT();
  const [progress, setProgress] = useState<{ vouched: number; needed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const finish = (predecessor: AgentPubKey) => {
    setDone(true);
    onTaken(predecessor);
  };
  usePolling(
    async () => {
      try {
        const taken = await mySuccession();
        if (taken) return finish(taken.predecessor);
        const vouches = await vouchesForMe();
        const best = await readiest(vouches);
        if (!best) return;
        setProgress({ vouched: best.vouches.length, needed: best.plan.threshold });
        if (best.vouches.length < best.plan.threshold) return;
        const head = await whereItStands(best.plan.account);
        await takeOver({ predecessor: best.plan.account, authority: { Guardians: { plan: best.plan.plan, head, vouches: best.vouches.map((v) => v.vouch) } } });
          finish(best.plan.account);
      } catch (err) {
        setError(describeError(err));
      }
    },
    { pollMs: POLL.waitingDevice, background: true },
    !done,
  );
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">{t("restore.askGuardians")}</h2>
      <p className="mb-4 text-sm text-ink-500">{t("restore.askGuardiansHow")}</p>
      <AccountCode agent={me} note={t("restore.askGuardiansNote")} />
      <p className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-400">
        <Spinner className="h-3 w-3" />
        {progress ? t("restore.vouchedCount", { n: progress.vouched, count: progress.needed }) : t("restore.waitingGuardians")}
      </p>
      {error && <Notice className="mt-3">{error}</Notice>}
    </>
  );
}

/// The account with the most vouches under its current plan, and those
/// vouches -- one per guardian.
async function readiest(vouches: VouchView[]): Promise<{ plan: PlanView; vouches: VouchView[] } | null> {
  const accounts = [...new Set(vouches.map((v) => bytesToHex(v.account)))];
  let best: { plan: PlanView; vouches: VouchView[] } | null = null;
  for (const hex of accounts) {
    const account = vouches.find((v) => bytesToHex(v.account) === hex)!.account;
    const plan = await recoveryPlanOf(account);
    if (!plan || plan.threshold === 0) continue;
    const current = vouches.filter((v) => bytesToHex(v.account) === hex && bytesEqual(v.plan, plan.plan));
    const oneEach = current.filter((v, i) => current.findIndex((w) => bytesEqual(w.guardian, v.guardian)) === i);
    if (!best || oneEach.length > best.vouches.length) best = { plan, vouches: oneEach };
  }
  return best;
}

/// Where an account stands: its latest action the network has seen. Just
/// after it was found (its plan's links arrive first), its history may take
/// a few seconds more to reach this device.
async function whereItStands(account: AgentPubKey): Promise<Uint8Array> {
  for (let attempt = 0; attempt < STANDING_ATTEMPTS; attempt++) {
    const head = await latestActionOf(account);
    if (head) return head;
    await wait(1000);
  }
  throw new Error(translate("restore.unreachable"));
}

const STANDING_ATTEMPTS = 15;

/// The account's details, confirmed for this device: the name and phone it
/// had (sealed to the old key, so carried only by a migration).
function ConfirmDetails({ predecessor, place, recovered, onDone }: { predecessor: AgentPubKey; place: AccountPlace; recovered: boolean; onDone: () => void }) {
  const reconnect = useSession((s) => s.reconnect);
  const t = useT();
  const { data: known } = useResource(`predecessor:${place}:${bytesToHex(predecessor)}`, () => readPredecessor(predecessor, place));
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const action = useAction();

  if (!known) return <Skeleton className="h-48 w-full" />;
  const shownName = name ?? known.name;
  const shownPhone = phone ?? known.phone;

  function finish() {
    if (!known) return;
    return action.run(async () => {
      // Their stores first -- safe to repeat -- then their profile, so a
      // failure here can simply be tried again.
      if (place === "previous") {
        for (const store of await previousStores()) await importStore(store.original_action);
      } else {
        for (const store of await catalogsOf(predecessor)) await moveStore(store.original_action);
      }
      await adoptPredecessor(known, shownName, shownPhone);
      await reconnect();
      onDone();
    }, { stayBusy: true });
  }

  return (
    <>
      <h2 className="mb-1 text-lg font-bold">{t("restore.here")}</h2>
      <p className="mb-4 text-sm text-ink-500">
        {t("restore.fromAccount", { fingerprint: keyFingerprint(predecessor) })} {recovered ? t("restore.checkDetails") : t("restore.detailsCame")}
      </p>
      <Field label={t("onboarding.name")} className="mb-3">
        <Input value={shownName} onChange={(e) => setName(e.target.value)} placeholder={t("onboarding.namePlaceholder")} />
      </Field>
      <Field label={t("onboarding.phone")} className="mb-3">
        <Input value={shownPhone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      {recovered && (known.profile?.roles.includes("Merchant") || known.profile?.roles.includes("Provider")) && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("restore.reconnectPayments")}</p>
      )}
      {recovered && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("restore.allergiesAgain")}</p>}
      {place === "previous" && (
        <p className="mb-3 rounded-lg bg-handshake-50 px-3 py-2 text-xs text-handshake-800">{t("restore.carried")}</p>
      )}
      {known.profile?.roles.includes("Merchant") && (
        <p className="mb-3 text-xs text-ink-500">{t("restore.stores")}</p>
      )}
      {action.error && <Notice className="mb-3">{action.error}</Notice>}
      <Button className="w-full" loading={action.busy} disabled={!shownName.trim()} onClick={finish}>
        {t("onboarding.enter")}
      </Button>
    </>
  );
}
