// Whom someone has blocked -- as themselves, or as their store -- with the
// way to lift each (docs/REPUTATION.md, phase 4). Their own list, from their
// own device's record; nobody else can read it.
import { Ban } from "lucide-react";
import { myBlocks, unblock } from "../../holochain/zomes/reputation";
import { getCatalog } from "../../holochain/zomes/catalog";
import { getProfileForAgent } from "../../holochain/zomes/profiles";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import type { MerchantCatalog, Party, Profile } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { shortAgentId } from "../../lib/ui/format";
import { Button, Card, Notice, SectionLabel } from "../ui";
import { useT } from "../../i18n";

/// A party's name, as the blocker would know it.
async function nameOf(party: Party): Promise<string | null> {
  if ("Store" in party) return decodeEntry<MerchantCatalog>(await getCatalog(party.Store)).business_name;
  const record = await getProfileForAgent(party.Person);
  return (record && decodeEntry<Profile>(record).display_name) || null;
}

export function BlockedList({ by, partyKey }: { by: Party; partyKey: string }) {
  const t = useT();
  const { data, reload } = useResource(`blocked-list:${partyKey}`, async () => {
    const parties = await myBlocks(by);
    return Promise.all(parties.map(async (party) => ({ party, name: await nameOf(party).catch(() => null) })));
  });
  const lifting = useAction();
  if (!data || data.length === 0) return null;
  return (
    <Card className="mb-4 p-4">
      <SectionLabel as="h2" icon={<Ban size={13} aria-hidden />} className="mb-1">{t("blocked.title")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t("blocked.detail")}</p>
      <ul className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
        {data.map(({ party, name }) => {
          const key = "Store" in party ? bytesToHex(party.Store) : bytesToHex(party.Person);
          const shown = name ?? ("Person" in party ? shortAgentId(party.Person) : t("blocked.aStore"));
          return (
            <li key={key} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0 truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{shown}</span>
              <Button variant="ghost" className="shrink-0 px-3 py-1.5 text-xs" loading={lifting.doing === key} disabled={lifting.busy} onClick={() => lifting.run(async () => { await unblock(by, party); await reload(); }, { as: key })}>
                {t("blocked.unblock")}
              </Button>
            </li>
          );
        })}
      </ul>
      {lifting.error && <Notice className="mt-2">{lifting.error}</Notice>}
    </Card>
  );
}
