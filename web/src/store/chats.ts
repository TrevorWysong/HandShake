// Each order's chat as this app has heard it since it started. Chat is
// never stored -- not on the network (dispatch `live`), not on this device --
// only held here, so a line that comes while someone's elsewhere in the app
// waits for them on the order, and the conversation's still there when they
// come back to it. Gone when the app closes; cleared when another identity
// signs in.
import { create } from "zustand";
import type { LiveSignal } from "../holochain/live";
import { myAgentPubKey } from "../holochain/client";
import { bytesEqual, bytesToHex } from "../holochain/decode";
import { forEachIdentity } from "./identityScope";

export interface ChatLine {
  /// Its place among every line held -- what's been read is up to one.
  seq: number;
  mine: boolean;
  text: string;
  sentAt: number;
}

/// The most lines held per order -- the latest. Its counterpart can send as
/// many as they like; this device holds a screenful's worth of history.
const MAX_LINES = 200;

let nextSeq = 1;

export const useChats = create<{ lines: Record<string, ChatLine[]> }>(() => ({ lines: {} }));

/// Holds a line on its order's chat.
export function holdChatLine(orderHex: string, line: Omit<ChatLine, "seq">): void {
  const seq = nextSeq++;
  useChats.setState(({ lines }) => ({ lines: { ...lines, [orderHex]: [...(lines[orderHex] ?? []), { ...line, seq }].slice(-MAX_LINES) } }));
}

/// Holds a chat line as it arrives -- for the app shell, listening the whole
/// time someone's signed in.
export function holdChatSignal(signal: LiveSignal): void {
  if (!("ChatMessage" in signal)) return;
  const message = signal.ChatMessage;
  holdChatLine(bytesToHex(message.order_ref), { mine: bytesEqual(message.from, myAgentPubKey()), text: message.text, sentAt: message.sent_at });
}

forEachIdentity(() => useChats.setState({ lines: {} }));
