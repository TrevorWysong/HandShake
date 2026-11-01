import { encodeHashToBase64 } from "@holochain/client";
import { fetchProfile } from "../../holochain/zomes/profiles";
import { bytesToHex } from "../../holochain/decode";
import type { AgentPubKey } from "../../holochain/types";
import { keyFingerprint } from "../../lib/account/accountMove";
import { useResource } from "../../lib/hooks/useResource";
import { useGuardianNames } from "../../store/guardianNames";
import { t as translate } from "../../i18n";

/// What to call someone: the name given them on this device, their public
/// name, or their key's fingerprint.
export function useDisplayName(agent: AgentPubKey): string {
  const named = useGuardianNames((s) => s.names[encodeHashToBase64(agent)]);
  const { data: profile } = useResource(named ? null : `profile:${bytesToHex(agent)}`, () => fetchProfile(agent));
  return named || profile?.display_name || translate("account.named", { fingerprint: keyFingerprint(agent) });
}
