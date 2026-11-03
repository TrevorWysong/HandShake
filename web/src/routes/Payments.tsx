// Payments: getting paid by card, for stores and drivers -- their own
// processor account, connected by pasting its keys into the payment agent
// (`paymentsAgent`) -- and, for everyone, the record of what they paid and
// were paid (Transparency).
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronRight, CreditCard, ExternalLink, ShieldCheck } from "lucide-react";
import type { Processor } from "../holochain/types";
import { paymentsAgent, type PaymentsAgent } from "../holochain/paymentsAgent";
import { Button, Card, Field, Input, Notice, Skeleton } from "../components/ui";
import { useResource } from "../lib/hooks/useResource";
import { useAction } from "../lib/hooks/useAction";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { useTerms } from "../store/network";
import { useT, type MessageKey } from "../i18n";

/// What each processor needs pasted in, and where its dashboard shows it.
const KEYS: Record<Exclude<Processor, "Test">, { dashboard: string; how: MessageKey; fields: { name: string; label: MessageKey; secret: boolean }[] }> = {
  Stripe: {
    dashboard: "https://dashboard.stripe.com/apikeys",
    how: "payments.how.stripe",
    fields: [
      { name: "publishable_key", label: "payments.key.publishable", secret: false },
      { name: "restricted_key", label: "payments.key.restricted", secret: true },
    ],
  },
  Square: {
    dashboard: "https://developer.squareup.com/apps",
    how: "payments.how.square",
    fields: [
      { name: "application_id", label: "payments.key.applicationId", secret: false },
      { name: "location_id", label: "payments.key.locationId", secret: false },
      { name: "access_token", label: "payments.key.accessToken", secret: true },
    ],
  },
  Clover: {
    dashboard: "https://www.clover.com/dashboard",
    how: "payments.how.clover",
    fields: [
      { name: "merchant_id", label: "payments.key.merchantId", secret: false },
      { name: "public_key", label: "payments.key.publicKey", secret: false },
      { name: "private_token", label: "payments.key.privateToken", secret: true },
    ],
  },
};

export function Payments() {
  const t = useT();
  const { data: agent } = useResource("payments-agent", paymentsAgent);
  const { data: connection, reload } = useResource(agent ? "payments-connection" : null, () => agent!.status());

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("payments.title")}
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-5">
          <p className="mb-1 flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
            <CreditCard size={16} className="text-handshake-600" /> {t("payments.gettingPaid")}
          </p>
          <p className="mb-4 text-xs text-ink-400">{t("payments.gettingPaidDetail")}</p>
          {agent === undefined ? (
            <Skeleton className="h-24" />
          ) : agent === null ? (
            <Notice tone="warn">{t("payments.needsDesktop")}</Notice>
          ) : connection === undefined ? (
            <Skeleton className="h-24" />
          ) : connection ? (
            <Connected processor={connection.processor} account={connection.account} live={connection.live} onDisconnect={async () => {
              await agent.disconnect();
              await reload();
            }} />
          ) : (
            <Connect agent={agent} onConnected={() => reload()} />
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Link to="/transparency" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 shadow-[var(--shadow-card)] dark:border-ink-800 dark:bg-ink-900">
          <ShieldCheck size={18} className="shrink-0 text-presence-600" />
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

function Connected({ processor, account, live, onDisconnect }: { processor: Processor; account: string; live: boolean; onDisconnect: () => Promise<void> }) {
  const t = useT();
  const action = useAction();
  return (
    <>
      <div className="mb-3 rounded-xl bg-ink-50 p-3 text-sm dark:bg-ink-800/60">
        <p className="font-semibold text-ink-900 dark:text-ink-50">{t("payments.paidInto", { processor })}</p>
        <p className="text-xs text-ink-400">
          {account} · {live ? t("payments.live") : t("payments.test")}
        </p>
      </div>
      {action.error && <Notice className="mb-2">{action.error}</Notice>}
      <Button variant="secondary" className="w-full" loading={action.busy} onClick={() => action.run(onDisconnect)}>
        {t("payments.disconnect")}
      </Button>
    </>
  );
}

function Connect({ agent, onConnected }: { agent: PaymentsAgent; onConnected: () => void }) {
  const t = useT();
  const live = useTerms().live_payments;
  const processors = (["Stripe", "Square", "Clover", ...(live ? [] : ["Test" as const])] as const) satisfies readonly Processor[];
  const [processor, setProcessor] = useState<Processor>("Stripe");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const action = useAction();
  const needs = processor === "Test" ? null : KEYS[processor];
  const complete = !needs || needs.fields.every((f) => keys[f.name]?.trim());

  const connect = () =>
    action.run(async () => {
      await agent.connect(processor, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.trim()])));
      setKeys({});
      onConnected();
    });

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {processors.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setProcessor(p);
              setKeys({});
            }}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${processor === p ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
          >
            {p}
          </button>
        ))}
      </div>
      {needs && (
        <>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-xs text-ink-500 dark:text-ink-400">
            <li>
              <a href={needs.dashboard} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-handshake-600 dark:text-handshake-400">
                {t("payments.openDashboard", { processor })} <ExternalLink size={11} />
              </a>
            </li>
            <li>{t(needs.how)}</li>
            <li>{t("payments.pasteBelow")}</li>
          </ol>
          {needs.fields.map((field) => (
            <Field key={field.name} label={t(field.label)} className="mb-3">
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={keys[field.name] ?? ""}
                onChange={(e) => setKeys((k) => ({ ...k, [field.name]: e.target.value }))}
              />
            </Field>
          ))}
          <p className="mb-3 text-[11px] text-ink-400">{t("payments.keysStayHere")}</p>
        </>
      )}
      {action.error && <Notice className="mb-2">{action.error}</Notice>}
      <Button className="w-full" loading={action.busy} disabled={!complete} onClick={connect}>
        {t("payments.connect", { processor })}
      </Button>
    </>
  );
}
