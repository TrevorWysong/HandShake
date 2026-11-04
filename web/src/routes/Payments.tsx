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

/// Each processor a payee can connect: who it suits, where its dashboard
/// shows the keys, and what to paste.
const PROCESSORS: Record<Processor, { blurb: MessageKey; dashboard: string | null; how: MessageKey | null; fields: { name: string; label: MessageKey; secret: boolean; placeholder: string }[] }> = {
  Stripe: {
    blurb: "payments.blurb.stripe",
    dashboard: "https://dashboard.stripe.com/apikeys",
    how: "payments.how.stripe",
    fields: [
      { name: "publishable_key", label: "payments.key.publishable", secret: false, placeholder: "pk_…" },
      { name: "restricted_key", label: "payments.key.restricted", secret: true, placeholder: "rk_…" },
    ],
  },
  Square: {
    blurb: "payments.blurb.square",
    dashboard: "https://developer.squareup.com/apps",
    how: "payments.how.square",
    fields: [
      { name: "application_id", label: "payments.key.applicationId", secret: false, placeholder: "sq0idp-…" },
      { name: "location_id", label: "payments.key.locationId", secret: false, placeholder: "L…" },
      { name: "access_token", label: "payments.key.accessToken", secret: true, placeholder: "EAAA…" },
    ],
  },
  Clover: {
    blurb: "payments.blurb.clover",
    dashboard: "https://www.clover.com/dashboard",
    how: "payments.how.clover",
    fields: [
      { name: "merchant_id", label: "payments.key.merchantId", secret: false, placeholder: "" },
      { name: "public_key", label: "payments.key.publicKey", secret: false, placeholder: "" },
      { name: "private_token", label: "payments.key.privateToken", secret: true, placeholder: "" },
    ],
  },
  Test: { blurb: "payments.blurb.test", dashboard: null, how: null, fields: [] },
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

  const steps: ReactNode[] = chosen.how && chosen.dashboard
    ? [
        <a key="dashboard" href={chosen.dashboard} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-handshake-600 dark:text-handshake-400">
          {t("payments.openDashboard", { processor })} <ExternalLink size={12} />
        </a>,
        t(chosen.how),
        t("payments.pasteBelow"),
      ]
    : [];

  return (
    <Card className="p-5">
      <Heading icon={<CreditCard size={20} />} title={t("payments.gettingPaid")} detail={t("payments.gettingPaidDetail")} />

      <SectionLabel className="mb-2 mt-5">{t("payments.choose")}</SectionLabel>
      <div role="radiogroup" aria-label={t("payments.choose")} className="grid gap-2 sm:grid-cols-2">
        {choices.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={processor === p}
            onClick={() => choose(p)}
            className={clsx(
              "rounded-2xl border p-3.5 text-left transition",
              processor === p ? "border-handshake-500 bg-handshake-50 ring-1 ring-handshake-500 dark:bg-handshake-900/20" : "border-ink-100 hover:border-ink-200 dark:border-ink-800 dark:hover:border-ink-700",
            )}
          >
            <span className="block text-sm font-bold text-ink-900 dark:text-ink-50">{p === "Test" ? t("payments.testProcessor") : p}</span>
            <span className="mt-0.5 block text-xs leading-snug text-ink-500">{t(PROCESSORS[p].blurb)}</span>
          </button>
        ))}
      </div>

      {steps.length > 0 && (
        <ol className="mt-5 flex flex-col gap-3">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-ink-600 dark:text-ink-300">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-100 text-xs font-bold text-ink-500 dark:bg-ink-800">{i + 1}</span>
              <span className="pt-0.5 leading-relaxed">{step}</span>
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
