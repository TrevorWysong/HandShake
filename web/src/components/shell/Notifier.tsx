import { useNavigate } from "react-router-dom";
import { notificationFor } from "../../lib/orders/notifications";
import { playChime } from "../../lib/ui/chime";
import { useLiveSignal, useLocalSignal } from "../../lib/hooks/useResource";
import { usePreferences } from "../../store/preferences";
import { holdChatSignal } from "../../store/chats";
import { useActiveOrders } from "../../store/activeOrders";
import { useCarrying } from "../../store/carrying";
import { useSession } from "../../store/session";
import { customerOrderPath } from "../../lib/orders/orderEntries";
import { bytesToHex } from "../../holochain/decode";
import { wakeCustomer } from "../../lib/network/push";
import type { LocalSignal } from "../../holochain/types";
import type { LiveSignal } from "../../holochain/live";

/// Tells this person about their orders as they change: a system
/// notification (when they've turned them on and allowed them), and a chime
/// for each new order waiting on their store. Everything else about a
/// change -- the screen refreshing -- happens on the same signals already.
///
/// Notifications reach this app while it's running, in front or behind;
/// a closed app hears nothing until it's opened again (see docs/DEPLOYMENT.md).
export function Notifier() {
  const navigate = useNavigate();
  const { notifications, newOrderChime } = usePreferences();
  const notify = (signal: LocalSignal | LiveSignal) => {
    // An order this store or driver changed: wake its customer's app too.
    if ("Wake" in signal) return wakeCustomer(signal.Wake);
    const found = notificationFor(signal);
    if (!found) return;
    const notice = "ChatMessage" in signal ? { ...found, route: chatRoute(bytesToHex(signal.ChatMessage.order_ref)) } : found;
    if (notice.urgent && "OrderPlaced" in signal && newOrderChime) playChime();
    // With the app in front, the screen itself shows the change; a new
    // order still pops up, since it's waiting on someone.
    const show = notifications && typeof Notification !== "undefined" && Notification.permission === "granted" && (document.visibilityState === "hidden" || notice.urgent);
    if (!show) return;
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag });
    shown.onclick = () => {
      window.focus();
      navigate(notice.route);
      shown.close();
    };
  };
  useLocalSignal(notify);
  useLiveSignal(notify);
  // Every order's chat, held wherever in the app they are.
  useLiveSignal(holdChatSignal);
  return null;
}

/// Where a chat line's notification opens: its order, as this person has it
/// -- their own order, a delivery they're carrying, or their store's queue.
function chatRoute(orderHex: string): string {
  const mine = useActiveOrders.getState().orders?.find((order) => order.row.hex === orderHex);
  if (mine) return customerOrderPath(mine.row);
  if (useCarrying.getState().rows?.some((row) => bytesToHex(row.hash) === orderHex)) return "/driver";
  return useSession.getState().profile?.roles.includes("Merchant") ? "/merchant" : "/";
}
