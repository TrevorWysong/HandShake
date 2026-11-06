// The terms of use: agreed to before anything else happens, and readable later
// from the profile.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { LanguagePicker } from "../components/shell/LanguagePicker";
import { Button, Checkbox } from "../components/ui";
import { TERMS } from "../lib/policies/terms";
import { TERMS_DRAFT, TERMS_VERSION } from "../lib/policies/termsVersion";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { useTermsAcceptance } from "../store/termsAcceptance";
import { appLocale, useT } from "../i18n";

function TermsBody() {
  const t = useT();
  return (
    <>
      {TERMS_DRAFT && <p role="note" className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">{t("terms.draft")}</p>}
      {TERMS[appLocale()].map((section) => (
        <section key={section.title} className="mb-6">
          <h2 className="mb-2 text-base font-bold tracking-tight text-ink-900 dark:text-ink-50">{section.title}</h2>
          <div className="flex flex-col gap-2">
            {section.points.map((point) => <p key={point} className="text-sm leading-relaxed text-ink-600 dark:text-ink-300">{point}</p>)}
          </div>
        </section>
      ))}
      <p className="text-xs text-ink-400">{t("terms.version", { version: TERMS_VERSION })}</p>
    </>
  );
}

/// The whole app waits on this, on first use and whenever the terms change.
export function TermsAcceptance() {
  const t = useT();
  const { acceptedVersion, accept } = useTermsAcceptance();
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="min-h-svh bg-ink-50 dark:bg-ink-950">
      <motion.main variants={staggerContainer} initial="hidden" animate="visible" className="mx-auto w-full max-w-2xl px-5 pt-8 pb-52">
        <motion.header variants={fadeSlideUp} className="mb-6">
          <img src="favicon.svg" alt="" className="mb-4 h-12 w-12 rounded-2xl" />
          <h1 className="text-[28px] font-black leading-tight tracking-tight text-ink-900 dark:text-ink-50">{t("terms.title")}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-600 dark:text-ink-300">{t(acceptedVersion ? "terms.changed" : "terms.acceptIntro")}</p>
        </motion.header>
        <motion.div variants={fadeSlideUp}>
          <LanguagePicker />
          <TermsBody />
        </motion.div>
      </motion.main>
      <div className="fixed inset-x-0 bottom-0 border-t border-ink-100 bg-white/95 backdrop-blur dark:border-ink-800 dark:bg-ink-900/95">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug text-ink-800 dark:text-ink-100">
            <Checkbox className="mt-0.5 h-5 w-5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {t("terms.agree")}
          </label>
          <Button className="w-full" disabled={!agreed} onClick={() => accept(TERMS_VERSION)}>{t("terms.continue")}</Button>
        </div>
      </div>
    </div>
  );
}

/// The terms, to read again.
export function TermsOfUse() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <article className="px-5 pt-4 pb-16">
      <button onClick={() => navigate(-1)} className="-ml-1 mb-6 flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
        <ArrowLeft size={16} /> {t("common.back")}
      </button>
      <h1 className="mb-6 text-[28px] font-black leading-tight tracking-tight text-ink-900 dark:text-ink-50">{t("terms.title")}</h1>
      <TermsBody />
    </article>
  );
}
