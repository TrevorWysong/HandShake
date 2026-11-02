// Redeeming a reward into the bag. A free item with choices is chosen
// first, from what the reward covers; any other reward goes straight in.
import { useState } from "react";
import { ItemSheet } from "../store/ItemSheet";
import { plainRewardLine, rewardItem, type RewardItem } from "../../lib/rewards/rewards";
import type { ItemRow } from "../../lib/storefront/menu";
import type { CartLine } from "../../store/cart";
import type { ActionHash, Reward } from "../../holochain/types";

/// `put` takes the reward and the line it adds, if any. Render `sheet`.
export function useRewardChooser(catalogRef: ActionHash | null, menu: ItemRow[], put: (reward: Reward, line: CartLine | null) => void) {
  const [choosing, setChoosing] = useState<{ reward: Reward; gift: RewardItem } | null>(null);

  const redeem = (reward: Reward) => {
    const gift = rewardItem(reward, menu);
    if (gift && gift.row.item.modifier_groups.length > 0) setChoosing({ reward, gift });
    else put(reward, gift && plainRewardLine(gift));
  };

  const sheet =
    choosing && catalogRef ? (
      <ItemSheet
        catalogRef={catalogRef}
        row={choosing.gift.row}
        gift={choosing.gift}
        onClose={() => setChoosing(null)}
        onDone={(line) => {
          put(choosing.reward, line);
          setChoosing(null);
        }}
      />
    ) : null;

  return { redeem, sheet };
}
