// Account & recovery: how this person gets their account back if they lose
// this device -- their recovery phrase, and guardians -- moving it to a new
// phone, and helping the people they guard recover theirs. No company can
// reset anyone's account here: these are the only ways back in, so this
// screen says plainly which are set up. See docs/RECOVERY.md.
import { LoadProblem } from "../../components/LoadProblem";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getMyDocket, getVerificationTerms } from "../../holochain/zomes/dispatch";
import { motion } from "framer-motion";
import { encodeHashToBase64 } from "@holochain/client";
import { ArrowLeft, ChevronRight, Gavel, HeartHandshake, KeyRound, QrCode, ShieldAlert, ShieldCheck, Smartphone, Sparkles, Users } from "lucide-react";
import type { PlanView } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { myRecoveryPlan, myWards } from "../../holochain/zomes/account";
import { AccountCode } from "../../components/account/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Badge, Card, CardSection, Skeleton } from "../../components/ui";
import { keyFingerprint } from "../../lib/account/accountMove";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { POLL } from "../../lib/network/poll";
import { useResource } from "../../lib/hooks/useResource";
import { useGuardianNames } from "../../store/guardianNames";
import { useSession } from "../../store/session";
import { useT } from "../../i18n";
import { formatDate } from "../../lib/ui/format";

import { PhraseSheet } from "./PhraseSheet";
import { GuardiansSheet } from "./GuardiansSheet";
import { MoveSheet } from "./MoveSheet";
import { HelpRecoverSheet } from "./HelpRecoverSheet";
import { UpgradeSheet } from "./UpgradeSheet";
import { useDisplayName } from "./useDisplayName";

type Open = "phrase" | "guardians" | "move" | "help" | "code" | "upgrade" | null;

export function AccountPage() {
  const agentPubKey = useSession((s) => s.agentPubKey);
  const t = useT();
  const hex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: plan, error: planError, reload } = useResource(hex && `plan:${hex}`, myRecoveryPlan);
  const { data: wards } = useResource(hex && `wards:${hex}`, myWards, { pollMs: POLL.slow });
  const [open, setOpen] = useState<Open>(null);
  const navigate = useNavigate();
  const names = useGuardianNames((s) => s.names);
  const { data: verification } = useResource("verification-terms", getVerificationTerms);
  const isVerifier = !!verification?.verifiers.some((v) => bytesToHex(v) === hex);
  // An arbiter has a docket; nobody else's ever has anything on it.
  const { data: docket } = useResource("docket", () => getMyDocket().then((page) => page.appeals), { pollMs: POLL.slow });

  if (!agentPubKey) return null;
  const hasPhrase = !!plan?.phrase_key;
  const guardianCount = plan?.guardians.length ?? 0;
  const protectedAccount = hasPhrase || guardianCount > 0;
  const close = () => setOpen(null);
  const saved = async () => {
    setOpen(null);
    await reload();
  };

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center gap-2">
        <Link to="/profile" aria-label={t("common.back")} className="grid h-9 w-9 place-items-center rounded-full bg-ink-100 text-ink-500 dark:bg-ink-800">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("profile.account")}</h1>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-5">
          {plan === undefined && planError ? (
            <LoadProblem compact error={planError} onRetry={reload} />
          ) : plan === undefined ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex items-start gap-3">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${protectedAccount ? "bg-presence-100 text-presence-600 dark:bg-presence-900/30" : "bg-amber-100 text-amber-600 dark:bg-amber-900/30"}`}>
                {protectedAccount ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
              </span>
              <div>
                <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{protectedAccount ? t("account.protected") : t("account.unprotected")}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  {protectedAccount ? t("account.protectedDetail") : t("account.unprotectedDetail")}
                </p>
              </div>
            </div>
          )}
        </Card>
      </motion.div>

      {docket && docket.length > 0 && (
        <motion.div variants={fadeSlideUp}>
          <CardSection divided title={t("account.arbiter")}>
            <Row icon={<Gavel size={18} />} title={t("account.appeals")} detail={t("account.waitingRuling", { count: docket.filter((a) => !a.ruling).length })} onClick={() => navigate("/arbitrate")} />
          </CardSection>
        </motion.div>
      )}

      {isVerifier && (
        <motion.div variants={fadeSlideUp}>
          <CardSection divided title={t("account.verifier")}>
            <Row icon={<ShieldCheck size={18} />} title={t("verify.title")} detail={t("account.verifyDetail")} onClick={() => navigate("/verify")} />
          </CardSection>
        </motion.div>
      )}

      {/* Moving to a new version: started from the code it shows. */}
      <motion.div variants={fadeSlideUp}>
        <CardSection divided title={t("account.newVersion")}>
          <Row icon={<Sparkles size={18} />} title={t("account.upgrade")} detail={t("account.upgradeDetail")} onClick={() => setOpen("upgrade")} />
        </CardSection>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <CardSection divided title={t("account.waysBack")}>
          <Row
            icon={<KeyRound size={18} />}
            title={t("account.phrase")}
            detail={hasPhrase ? t("account.setUpOn", { date: formatDate(plan!.published_at) }) : t("account.phraseDetail")}
            badge={hasPhrase ? <Badge tone="success">{t("account.on")}</Badge> : <Badge>{t("account.off")}</Badge>}
            onClick={() => setOpen("phrase")}
          />
          <Row
            icon={<Users size={18} />}
            title={t("account.guardians")}
            detail={
              guardianCount > 0
                ? `${plan!.guardians.map((g) => names[encodeHashToBase64(g)] || keyFingerprint(g)).join(", ")} · ${t("account.anyCanVouch", { count: plan!.threshold })}`
                : t("account.guardiansDetail")
            }
            badge={guardianCount > 0 ? <Badge tone="success">{guardianCount}</Badge> : <Badge>{t("account.off")}</Badge>}
            onClick={() => setOpen("guardians")}
          />
        </CardSection>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <CardSection divided title={t("account.thisDevice")}>
          <Row icon={<Smartphone size={18} />} title={t("account.move")} detail={t("account.moveDetail")} onClick={() => setOpen("move")} />
          <Row icon={<QrCode size={18} />} title={t("account.code")} detail={t("account.codeDetail")} onClick={() => setOpen("code")} />
        </CardSection>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <CardSection divided title={t("account.wards")}>
          {wards === undefined ? (
            <div className="p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : wards.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{t("account.noWards")}</p>
          ) : (
            <>
              {wards.map((ward) => (
                <WardRow key={bytesToHex(ward.account)} ward={ward} />
              ))}
              <Row icon={<HeartHandshake size={18} />} title={t("account.help")} detail={t("account.helpDetail")} onClick={() => setOpen("help")} />
            </>
          )}
        </CardSection>
      </motion.div>

      {open === "phrase" && <PhraseSheet plan={plan ?? null} onClose={close} onSaved={saved} />}
      {open === "guardians" && <GuardiansSheet plan={plan ?? null} me={agentPubKey} onClose={close} onSaved={saved} />}
      {open === "move" && <MoveSheet onClose={close} />}
      {open === "upgrade" && <UpgradeSheet me={agentPubKey} onClose={close} />}
      {open === "help" && wards && <HelpRecoverSheet wards={wards} me={agentPubKey} onClose={close} />}
      {open === "code" && (
        <Sheet open onClose={close} title={t("account.code")} subtitle={t("account.codeSubtitle")}>
          <AccountCode agent={agentPubKey} note={t("account.codeNote")} />
        </Sheet>
      )}
    </motion.div>
  );
}

function Row({ icon, title, detail, badge, onClick }: { icon: React.ReactNode; title: string; detail: string; badge?: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-ink-50 dark:hover:bg-ink-800/50">
      <span className="text-ink-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{title}</span>
        <span className="block truncate text-xs text-ink-400">{detail}</span>
      </span>
      {badge}
      <ChevronRight size={16} className="shrink-0 text-ink-300" />
    </button>
  );
}

function WardRow({ ward }: { ward: PlanView }) {
  const name = useDisplayName(ward.account);
  const t = useT();
  return (
    <div className="flex items-center gap-3 p-4">
      <HeartHandshake size={18} className="text-ink-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{name}</p>
        <p className="text-xs text-ink-400">
          {t("account.wardDetail", { count: ward.guardians.length, needed: ward.threshold })}
        </p>
      </div>
    </div>
  );
}
