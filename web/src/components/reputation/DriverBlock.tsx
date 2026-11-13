// "…" on a driver, for the customer: blocking them -- they no longer see the
// customer's orders, nor the customer their bids (docs/REPUTATION.md, phase 4).
import { myAgentPubKey } from "../../holochain/client";
import { bytesToHex } from "../../holochain/decode";
import type { AgentPubKey } from "../../holochain/types";
import { BlockActions, type Blockable } from "./BlockActions";

export function DriverBlock({ driver, name, onChanged }: { driver: AgentPubKey; name: string; onChanged?: () => void }) {
  const me = myAgentPubKey();
  return (
    <BlockActions
      by={{ Person: me }}
      partyKey={`person:${bytesToHex(me)}`}
      targetsKey={`driver:${bytesToHex(driver)}`}
      targets={async (): Promise<Blockable[]> => [{ party: { Person: driver }, name, role: "driver" }]}
      onChanged={onChanged}
    />
  );
}
