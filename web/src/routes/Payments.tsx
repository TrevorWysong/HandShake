// Payments: getting paid by card, for stores and drivers -- their own
// processor account, connected by pasting its keys into the payment agent
// (`paymentsAgent`), which checks them with the processor and asks the
// person to confirm outside the page -- and, for everyone, the record of what
// they paid and were paid (Transparency).
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, ChevronRight, CreditCard, ExternalLink, Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import type { Processor } from "../holochain/types";
import { paymentsAgent, type PaymentsAgent, type PaymentsConnection } from "../holochain/paymentsAgent";
import { Badge, Button, Card, Field, Input, Notice, SectionLabel, Skeleton } from "../components/ui";
import { useResource } from "../lib/hooks/useResource";
import { useAction } from "../lib/hooks/useAction";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { useSession } from "../store/session";
import { useTerms } from "../store/network";
import { useT, type MessageKey } from "../i18n";

/// One step of connecting a processor: what to do, and where, if there's
/// a page to open.
interface Step {
  text: MessageKey;
  link?: { href: string; label: MessageKey };
}

/// Each processor a payee can connect: who it suits, what it takes, how to
/// find its keys step by step, and what to paste.
const PROCESSORS: Record<Processor, { blurb: MessageKey; need: MessageKey | null; steps: Step[]; fields: { name: string; label: MessageKey; secret: boolean; placeholder: string }[] }> = {
  Stripe: {
    blurb: "payments.blurb.stripe",
    need: "payments.need.stripe",
    steps: [
      { text: "payments.stripe.1", link: { href: "https://dashboard.stripe.com/register", label: "payments.stripe.1link" } },
      { text: "payments.stripe.2" },
      { text: "payments.stripe.3", link: { href: "https://dashboard.stripe.com/apikeys", label: "payments.stripe.3link" } },
      { text: "payments.stripe.4" },
      { text: "payments.stripe.5" },
      { text: "payments.stripe.6" },
    ],
    fields: [
      { name: "publishable_key", label: "payments.key.publishable", secret: false, placeholder: "pk_…" },
      { name: "restricted_key", label: "payments.key.restricted", secret: true, placeholder: "rk_…" },
    ],
  },
  Square: {
    blurb: "payments.blurb.square",
    need: "payments.need.square",
    steps: [
      { text: "payments.square.1", link: { href: "https://squareup.com/signup", label: "payments.square.1link" } },
      { text: "payments.square.2", link: { href: "https://developer.squareup.com/apps", label: "payments.square.2link" } },
      { text: "payments.square.3" },
      { text: "payments.square.4" },
      { text: "payments.square.5" },
    ],
    fields: [
      { name: "application_id", label: "payments.key.applicationId", secret: false, placeholder: "sq0idp-…" },
      { name: "location_id", label: "payments.key.locationId", secret: false, placeholder: "L…" },
      { name: "access_token", label: "payments.key.accessToken", secret: true, placeholder: "EAAA…" },
    ],
  },
  Clover: {
    blurb: "payments.blurb.clover",
    need: "payments.need.clover",
    steps: [
      { text: "payments.clover.1", link: { href: "https://www.clover.com/dashboard", label: "payments.clover.1link" } },
      { text: "payments.clover.2" },
      { text: "payments.clover.3" },
      { text: "payments.clover.4" },
      { text: "payments.clover.5" },
    ],
    fields: [
      { name: "merchant_id", label: "payments.key.merchantId", secret: false, placeholder: "" },
      { name: "public_key", label: "payments.key.publicKey", secret: false, placeholder: "" },
      { name: "private_token", label: "payments.key.privateToken", secret: true, placeholder: "" },
    ],
  },
  Test: { blurb: "payments.blurb.test", need: null, steps: [], fields: [] },
};

export function Payments() {
  const t = useT();
  const roles = useSession((s) => s.profile?.roles ?? []);
  const paid = roles.includes("Merchant") || roles.includes("Provider");

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center gap-2">
        <Link to="/profile" aria-label={t("common.back")} className="grid h-9 w-9 place-items-center rounded-full bg-ink-100 text-ink-500 dark:bg-ink-800">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("payments.title")}</h1>
      </motion.div>

      {paid && <GettingPaid />}

      <motion.div variants={fadeSlideUp}>
        <Link to="/transparency" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 dark:border-ink-800 dark:bg-ink-900">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-presence-500/10 text-presence-600">
            <ShieldCheck size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{t("payments.history")}</span>
            <span className="block text-xs text-ink-400">{t("payments.historyDetail")}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-ink-300" />
        </Link>
      </motion.div>
    </motion.div>
  );
}

/// Where a store or driver is paid: connected, or how to connect.
function GettingPaid() {
  const t = useT();
  const { data: agent } = useResource("payments-agent", paymentsAgent);
  const { data: connection, reload } = useResource(agent ? "payments-connection" : null, () => agent!.status());

  return (
    <motion.div variants={fadeSlideUp} className="mb-4">
      {agent === undefined || (agent && connection === undefined) ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : agent === null ? (
        <Card className="p-5">
          <Heading icon={<CreditCard size={20} />} title={t("payments.gettingPaid")} detail={t("payments.gettingPaidDetail")} />
          <Notice tone="warn" className="mt-4">{t("payments.needsDesktop")}</Notice>
        </Card>
      ) : connection ? (
        <Connected connection={connection} agent={agent} onChange={() => reload()} />
      ) : (
        <Connect agent={agent} onConnected={() => reload()} />
      )}
    </motion.div>
  );
}

function Heading({ icon, title, detail, tone = "brand" }: { icon: ReactNode; title: string; detail: string; tone?: "brand" | "success" }) {
  return (
    <div className="flex items-start gap-3">
      <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-full", tone === "success" ? "bg-presence-500/10 text-presence-600" : "bg-handshake-100 text-handshake-600 dark:bg-handshake-900/30")}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{detail}</p>
      </div>
    </div>
  );
}

function Connected({ connection, agent, onChange }: { connection: PaymentsConnection; agent: PaymentsAgent; onChange: () => void }) {
  const t = useT();
  const action = useAction();
  return (
    <Card className="p-5">
      <Heading tone="success" icon={<CheckCircle2 size={20} />} title={t("payments.paidInto", { processor: connection.processor })} detail={t("payments.connectedDetail")} />
      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 dark:bg-ink-800/60">
        <span className="min-w-0 truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{connection.account}</span>
        <Badge tone={connection.live ? "success" : "warn"}>{connection.live ? t("payments.live") : t("payments.test")}</Badge>
      </div>
      {action.error && <Notice className="mt-3">{action.error}</Notice>}
      <Button
        variant="ghost"
        className="mt-3 w-full text-xs"
        loading={action.busy}
        onClick={() =>
          action.run(async () => {
            await agent.disconnect();
            onChange();
          })
        }
      >
        {t("payments.disconnect")}
      </Button>
    </Card>
  );
}

function Connect({ agent, onConnected }: { agent: PaymentsAgent; onConnected: () => void }) {
  const t = useT();
  const live = useTerms().live_payments;
  const choices: Processor[] = live ? ["Stripe", "Square", "Clover"] : ["Stripe", "Square", "Clover", "Test"];
  const [processor, setProcessor] = useState<Processor>(live ? "Stripe" : "Test");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const action = useAction();
  const chosen = PROCESSORS[processor];
  const complete = chosen.fields.every((f) => keys[f.name]?.trim());

  const choose = (next: Processor) => {
    setProcessor(next);
    setKeys({});
    setShown({});
    action.setError(null);
  };
  const connect = () =>
    action.run(async () => {
      await agent.connect(processor, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.trim()])));
      setKeys({});
      onConnected();
    });

  return (
    <Card className="p-5">
      <Heading icon={<CreditCard size={20} />} title={t("payments.gettingPaid")} detail={t("payments.gettingPaidDetail")} />

      <SectionLabel className="mb-2 mt-5">{t("payments.choose")}</SectionLabel>
      <div role="radiogroup" aria-label={t("payments.choose")} className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {choices.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={processor === p}
            onClick={() => choose(p)}
            className={clsx(
              "flex flex-col items-start justify-start rounded-2xl border p-3 text-left transition sm:p-3.5",
              processor === p ? "border-handshake-500 bg-handshake-50 ring-1 ring-handshake-500 dark:bg-handshake-900/20" : "border-ink-100 hover:border-ink-200 dark:border-ink-800 dark:hover:border-ink-700",
            )}
          >
            <span className="block text-sm font-bold text-ink-900 dark:text-ink-50">{p === "Test" ? t("payments.testProcessor") : p}</span>
            <span className="mt-0.5 line-clamp-3 block text-[11px] leading-snug text-ink-500 sm:text-xs">{t(PROCESSORS[p].blurb)}</span>
          </button>
        ))}
      </div>

      {!live && processor !== "Test" && <Notice tone="warn" className="mt-4">{t("payments.testNetwork")}</Notice>}

      {chosen.need && <p className="mt-5 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t(chosen.need)}</p>}

      {chosen.steps.length > 0 && (
        <ol className="relative mt-4 flex flex-col gap-4">
          {/* The thread joining the steps. */}
          <span aria-hidden className="absolute bottom-3 left-3 top-3 w-px bg-ink-100 dark:bg-ink-800" />
          {chosen.steps.map((step, i) => (
            <li key={step.text} className="relative flex gap-3">
              <span className="relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-handshake-500 text-[11px] font-bold text-white ring-4 ring-white dark:ring-ink-900">{i + 1}</span>
              <div className="min-w-0 pt-0.5">
                <p className="text-sm leading-relaxed text-ink-700 dark:text-ink-200">{t(step.text)}</p>
                {step.link && (
                  <a href={step.link.href} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-handshake-50 px-3 py-1.5 text-xs font-semibold text-handshake-700 transition hover:bg-handshake-100 dark:bg-handshake-900/30 dark:text-handshake-300">
                    {t(step.link.label)} <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {chosen.fields.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {chosen.fields.map((field) => (
            <Field key={field.name} label={t(field.label)}>
              <Input
                type={field.secret && !shown[field.name] ? "password" : "text"}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={field.placeholder}
                className="font-mono text-xs"
                value={keys[field.name] ?? ""}
                onChange={(e) => setKeys((k) => ({ ...k, [field.name]: e.target.value }))}
                suffix={
                  field.secret ? (
                    <button type="button" aria-label={shown[field.name] ? t("payments.hideKey") : t("payments.showKey")} onClick={() => setShown((s) => ({ ...s, [field.name]: !s[field.name] }))} className="grid h-6 w-6 place-items-center text-ink-400 hover:text-ink-600">
                      {shown[field.name] ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  ) : undefined
                }
              />
            </Field>
          ))}
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-400">
            <Lock size={12} className="mt-0.5 shrink-0" /> {t("payments.keysStayHere")}
          </p>
        </div>
      )}

      {action.error && <Notice className="mt-3">{action.error}</Notice>}
      <Button className="mt-4 w-full" loading={action.busy} disabled={!complete} onClick={connect}>
        {processor === "Test" ? t("payments.connectTest") : t("payments.connect", { processor })}
      </Button>
    </Card>
  );
}
