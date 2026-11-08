// Chat between an order's two active parties -- a delivery's customer and
// driver, a pickup's customer and store -- app to app: see holochain/live.ts,
// and dispatch_coordinator::live for why it's deliberately never stored.
// Its lines are held for the app while it runs (`store/chats`), so they're
// here however someone moves round the app, and gone with a reload.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, MessageCircle, Send } from "lucide-react";
import clsx from "clsx";
import { sendChatMessage } from "../../holochain/live";
import { bytesToHex } from "../../holochain/decode";
import { formatClockTime, nowMicros } from "../../lib/ui/format";
import type { ActionHash } from "../../holochain/types";
import { MAX_NOTE_CHARS } from "../../holochain/types";
import { holdChatLine, useChats, type ChatLine } from "../../store/chats";
import { useT } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";

const NO_LINES: ChatLine[] = [];

interface Props {
  orderRef: ActionHash;
  title: string;
  /// Who's on the other end ("Store", "Customer"), over their lines.
  counterpart: string;
  /// Folded to its title until opened, with a count of what's arrived
  /// unread -- for a list of orders, each with its own chat.
  collapsible?: boolean;
}

export function ChatPanel({ orderRef, title, counterpart, collapsible = false }: Props) {
  const t = useT();
  const orderHex = bytesToHex(orderRef);
  const lines = useChats((s) => s.lines[orderHex]) ?? NO_LINES;
  const [open, setOpen] = useState(!collapsible);
  // Folded, what came before it was shown is unread.
  const [readUpTo, setReadUpTo] = useState(0);
  const [draft, setDraft] = useState("");
  const sending = useAction();

  const latest = lines.length ? lines[lines.length - 1].seq : 0;
  const unread = open ? 0 : lines.filter((line) => !line.mine && line.seq > readUpTo).length;

  // Opening or folding it, everything so far has been seen.
  function toggle() {
    setOpen((o) => !o);
    setReadUpTo(latest);
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    // Kept in the box when it fails, to try again: the other side may be
    // offline.
    return sending.run(async () => {
      await sendChatMessage(orderRef, text);
      // A direct signal only reaches the *other* party -- show our own line
      // here as it goes.
      holdChatLine(orderHex, { mine: true, text, sentAt: nowMicros() });
      setDraft("");
    });
  }

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-100 bg-white dark:border-ink-800 dark:bg-ink-900">
      <button
        type="button"
        onClick={collapsible ? toggle : undefined}
        disabled={!collapsible}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left disabled:cursor-default"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-handshake-50 text-handshake-600 dark:bg-handshake-900/30 dark:text-handshake-400">
          <MessageCircle size={14} />
        </span>
        <span className="flex-1 text-sm font-semibold text-ink-900 dark:text-ink-50">{title}</span>
        {unread > 0 && <span className="rounded-full bg-handshake-500 px-2 py-0.5 text-[10px] font-bold text-white">{unread}</span>}
        {collapsible && <ChevronDown size={16} className={clsx("text-ink-400 transition-transform", open && "rotate-180")} />}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}>
            {/* Newest last, laid out bottom-up: the browser keeps the
                latest line in view as lines arrive, with nothing to scroll. */}
            <div className="flex max-h-64 min-h-20 flex-col-reverse gap-2 overflow-y-auto border-t border-ink-100 px-4 py-3 dark:border-ink-800" aria-live="polite">
              {lines.length === 0 && <p className="m-auto text-center text-xs text-ink-400">{t("chat.empty")}</p>}
              {lines
                .map((line, i) => {
                  const startsRun = i === 0 || lines[i - 1].mine !== line.mine;
                  return (
                    <div key={line.seq} className={clsx("flex flex-col", line.mine ? "items-end" : "items-start", startsRun && i > 0 && "mt-1")}>
                      {startsRun && !line.mine && <p className="mb-0.5 px-1 text-[10px] font-semibold text-ink-400">{counterpart}</p>}
                      <div
                        className={clsx(
                          "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-snug",
                          line.mine ? "rounded-br-md bg-handshake-500 text-white" : "rounded-bl-md bg-ink-100 text-ink-800 dark:bg-ink-800 dark:text-ink-100",
                        )}
                      >
                        {line.text}
                      </div>
                      <p className="mt-0.5 px-1 text-[10px] text-ink-300">{formatClockTime(line.sentAt)}</p>
                    </div>
                  );
                })
                .reverse()}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className="flex items-center gap-2 border-t border-ink-100 p-2 dark:border-ink-800"
            >
              <input
                maxLength={MAX_NOTE_CHARS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("chat.placeholder")}
                aria-label={t("chat.placeholder")}
                className="min-w-0 flex-1 rounded-full bg-ink-50 px-4 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-handshake-300 dark:bg-ink-800 dark:text-ink-50"
              />
              <motion.button
                whileTap={{ scale: 0.9 }}
                type="submit"
                disabled={!draft.trim() || sending.busy}
                aria-label={t("chat.send")}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-handshake-500 text-white transition-opacity disabled:opacity-40"
              >
                <Send size={15} />
              </motion.button>
            </form>
            {sending.error && <p className="px-4 pb-2 text-[11px] text-amber-600 dark:text-amber-400">{t("chat.notSent")}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
