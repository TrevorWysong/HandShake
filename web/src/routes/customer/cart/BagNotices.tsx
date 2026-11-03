// A goodie bag the order can't have as it stands -- offered only the other
// way, its window closed, or the customer's own -- said beside the choice
// that decides it, with the ways out: switch how it's had, or take it out.
import { motion } from "framer-motion";
import { Button } from "../../../components/ui";
import { lineKey, useCart } from "../../../store/cart";
import type { BagProblem } from "../../../lib/storefront/bags";
import { fadeSlideUp } from "../../../lib/ui/motion";
import { useT } from "../../../i18n";

export function BagNotices({ problems, delivery, onSwitch }: { problems: BagProblem[]; delivery: boolean; onSwitch: (() => void) | null }) {
  const t = useT();
  const cart = useCart();
  // Something else to deliver (or collect) once the bag's out.
  const others = cart.lines.length > problems.length;
  return (
    <>
      {problems.map(({ line, reason }) => (
        <motion.div key={lineKey(line)} variants={fadeSlideUp} role="status" className="mb-4 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-900/15">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-handshake-500 text-lg" aria-hidden>
            🎁
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-amber-950 dark:text-amber-100">
              {reason === "own" ? t("cart.bag.own", { bag: line.name }) : reason === "closed" ? t("cart.bag.closed", { bag: line.name }) : t(delivery ? "cart.bag.notDelivered" : "cart.bag.notPickedUp", { bag: line.name })}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
              {reason === "own" ? t("cart.bag.ownDetail") : reason === "closed" ? t("cart.bag.closedDetail") : t(delivery ? (others ? "cart.bag.switchToPickup" : "cart.bag.switchToPickupOnly") : others ? "cart.bag.switchToDelivery" : "cart.bag.switchToDeliveryOnly")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {reason === "way" && onSwitch && (
                <Button className="px-3.5 py-1.5 text-xs" onClick={onSwitch}>
                  {t(delivery ? "cart.bag.usePickup" : "cart.bag.useDelivery")}
                </Button>
              )}
              <Button variant="secondary" className="px-3.5 py-1.5 text-xs" onClick={() => cart.removeLine(lineKey(line))}>
                {t("cart.bag.remove")}
              </Button>
            </div>
          </div>
        </motion.div>
      ))}
    </>
  );
}
