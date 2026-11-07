// A storefront's "About & contact": where the store is, when it's open, and
// how to reach it -- each a row a customer taps. Rows a store hasn't
// filled in aren't shown, and every link comes from `lib/storefront/contact.ts`,
// which builds one only from details that pass validation's rules.
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Clock, Copy, Globe, Mail, MapPin, Phone } from "lucide-react";
import clsx from "clsx";
import { directionsHref, mailtoHref, opensAppLinks, telHref, websiteHref, websiteLabel } from "../../lib/storefront/contact";
import { describeWeek, localWeekdayMinute, storeStatus } from "../../lib/storefront/storeHours";
import { formatCatalogAddress } from "../../lib/ui/format";
import { useClock } from "../../lib/hooks/useClock";
import type { MerchantCatalog } from "../../holochain/types";
import { useT } from "../../i18n";
import { SectionLabel } from "../ui";

export function StoreContact({ catalog }: { catalog: MerchantCatalog }) {
  const t = useT();
  const address = formatCatalogAddress(catalog);
  const directions = directionsHref(catalog.location);
  const tel = telHref(catalog.phone);
  const mailto = mailtoHref(catalog.email);
  const website = websiteHref(catalog.website);
  const appLinks = opensAppLinks();

  return (
    <section className="mt-6">
      <SectionLabel as="h2" className="mb-2">
        {t("storeContact.title")}
      </SectionLabel>
      <div className="divide-y divide-ink-100 overflow-hidden rounded-2xl border border-ink-100 bg-white dark:divide-ink-800 dark:border-ink-800 dark:bg-ink-900">
        <HoursRow catalog={catalog} />
        {address && <Row icon={<MapPin size={16} />} primary={address} secondary={t("storeContact.directions")} href={directions} external />}
        {tel && (appLinks ? <Row icon={<Phone size={16} />} primary={catalog.phone} secondary={t("storeContact.call")} href={tel} /> : <CopyRow icon={<Phone size={16} />} text={catalog.phone} />)}
        {mailto && (appLinks ? <Row icon={<Mail size={16} />} primary={catalog.email} secondary={t("storeContact.email")} href={mailto} /> : <CopyRow icon={<Mail size={16} />} text={catalog.email} />)}
        {website && <Row icon={<Globe size={16} />} primary={websiteLabel(website)} secondary={t("storeContact.website")} href={website} external />}
      </div>
    </section>
  );
}

/// How to reach the store right now, for someone with a problem at its counter:
/// its phone and email, if it's given them. Nothing if it hasn't.
export function StoreReach({ catalog, className }: { catalog: MerchantCatalog; className?: string }) {
  const t = useT();
  const tel = telHref(catalog.phone);
  const mailto = mailtoHref(catalog.email);
  const appLinks = opensAppLinks();
  if (!tel && !mailto) return null;
  return (
    <div className={clsx("divide-y divide-ink-100 overflow-hidden rounded-2xl border border-ink-100 bg-white dark:divide-ink-800 dark:border-ink-800 dark:bg-ink-900", className)}>
      {tel && (appLinks ? <Row icon={<Phone size={16} />} primary={catalog.phone} secondary={t("storeContact.call")} href={tel} /> : <CopyRow icon={<Phone size={16} />} text={catalog.phone} />)}
      {mailto && (appLinks ? <Row icon={<Mail size={16} />} primary={catalog.email} secondary={t("storeContact.email")} href={mailto} /> : <CopyRow icon={<Mail size={16} />} text={catalog.email} />)}
    </div>
  );
}

function RowIcon({ children }: { children: ReactNode }) {
  return <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-handshake-50 text-handshake-600 dark:bg-handshake-900/30 dark:text-handshake-400">{children}</span>;
}

const rowClass = "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50 active:bg-ink-100 dark:hover:bg-ink-800/60 dark:active:bg-ink-800";

function RowText({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium text-ink-900 dark:text-ink-50">{primary}</span>
      <span className="block text-xs text-handshake-600 dark:text-handshake-400">{secondary}</span>
    </span>
  );
}

/// A row that opens something: a web page or directions in the browser, a
/// call or an email on the device.
function Row({ icon, primary, secondary, href, external = false }: { icon: ReactNode; primary: string; secondary: string; href: string | null; external?: boolean }) {
  if (!href) {
    return (
      <div className={clsx(rowClass, "hover:bg-transparent active:bg-transparent")}>
        <RowIcon>{icon}</RowIcon>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900 dark:text-ink-50">{primary}</span>
      </div>
    );
  }
  return (
    <a href={href} {...(external && { target: "_blank", rel: "noopener noreferrer" })} className={rowClass}>
      <RowIcon>{icon}</RowIcon>
      <RowText primary={primary} secondary={secondary} />
    </a>
  );
}

/// A number or address copied to paste elsewhere -- where the app can't
/// hand it to the device.
function CopyRow({ icon, text }: { icon: ReactNode; text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard here; the text is on screen to select.
    }
  }
  return (
    <button type="button" onClick={copy} className={rowClass}>
      <RowIcon>{icon}</RowIcon>
      <RowText primary={text} secondary={copied ? t("storeContact.copied") : t("storeContact.copy")} />
      {copied ? (
        // Shown for a moment, then back to "Tap to copy" -- the moment
        // ends with the row, if it goes first.
        <motion.span initial={{ scale: 0.6 }} animate={{ scale: [0.6, 1, 1] }} transition={{ duration: 1.5, times: [0, 0.15, 1] }} onAnimationComplete={() => setCopied(false)}>
          <Check size={16} className="text-presence-600" />
        </motion.span>
      ) : (
        <Copy size={15} className="text-ink-300" />
      )}
    </button>
  );
}

/// Whether the store's open now, and -- opened -- its week, today's line
/// marked, in the store's own time zone.
function HoursRow({ catalog }: { catalog: MerchantCatalog }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const now = useClock();
  const status = storeStatus(catalog, now);
  const week = catalog.weekly_hours.length ? describeWeek(catalog.weekly_hours) : [];
  const today = localWeekdayMinute(catalog.time_zone, now).weekday;
  const statusLine = <span className={clsx("block truncate text-sm font-semibold", status.open ? "text-presence-600" : "text-red-500")}>{status.label}</span>;

  if (!week.length) {
    return (
      <div className={clsx(rowClass, "hover:bg-transparent active:bg-transparent")}>
        <RowIcon>
          <Clock size={16} />
        </RowIcon>
        <span className="min-w-0 flex-1">{statusLine}</span>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={rowClass}>
        <RowIcon>
          <Clock size={16} />
        </RowIcon>
        <span className="min-w-0 flex-1">
          {statusLine}
          <span className="block text-xs text-ink-400">{t("storeContact.hours")}</span>
        </span>
        <ChevronDown size={16} className={clsx("text-ink-400 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.dl
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 overflow-hidden px-4 pb-3 pl-16 text-sm"
          >
            {week.map(({ days, hours, weekdays }) => {
              const isToday = weekdays.includes(today);
              return (
                <div key={days} className={clsx("contents", isToday ? "font-semibold text-ink-900 dark:text-ink-50" : "text-ink-500 dark:text-ink-400")}>
                  <dt>{days}</dt>
                  <dd className="text-right tabular-nums">{hours}</dd>
                </div>
              );
            })}
            <dd className="col-span-2 mt-1 text-xs font-normal text-ink-400">{t("storeContact.timeZone", { zone: catalog.time_zone.replace(/_/g, " ") })}</dd>
          </motion.dl>
        )}
      </AnimatePresence>
    </div>
  );
}
