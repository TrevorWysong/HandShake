// Which of an item's choices an item reward or promo covers -- "a medium
// two-topping pizza": for each of the item's choice groups, nothing (open,
// and charged as usual), or the options that qualify -- none picked, any --
// and how many of the chosen ones it pays for (`catalog_types::ChoiceTerms`).
import { getModifierGroups } from "../../../holochain/zomes/catalog";
import { bytesEqual, bytesToHex, decodeEntry } from "../../../holochain/decode";
import { MAX_LINE_CHOICES, type ChoiceTerms, type ModifierGroup } from "../../../holochain/types";
import { isSingleChoice } from "../../../lib/storefront/choices";
import type { ItemRow } from "../../../lib/storefront/menu";
import { useResource } from "../../../lib/hooks/useResource";
import { Chip, Stepper, Switch } from "../../../components/ui";
import { useT } from "../../../i18n";
import type { GroupRow } from "./ChoicesSection";

export function ChoiceTermsEditor({ catalogRef, row, value, onChange }: { catalogRef: Uint8Array; row: ItemRow; value: ChoiceTerms[]; onChange: (terms: ChoiceTerms[]) => void }) {
  const t = useT();
  const refs = row.item.modifier_groups;
  const { data: groups = [] } = useResource(refs.length > 0 ? `item-groups:${bytesToHex(row.version)}:terms` : null, async (): Promise<GroupRow[]> => {
    const views = await getModifierGroups(catalogRef, refs);
    return refs.flatMap((ref) => {
      const view = views.find((v) => bytesEqual(v.original_action, ref));
      return view ? [{ hash: ref, group: decodeEntry<ModifierGroup>(view.record) }] : [];
    });
  });
  if (refs.length === 0) return null;

  // Kept in the item's group order, so the same terms read the same.
  const put = (group: Uint8Array, term: ChoiceTerms | null) =>
    onChange(groups.flatMap(({ hash }) => (bytesEqual(hash, group) ? (term ? [term] : []) : value.filter((v) => bytesEqual(v.group, hash)))));

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{t("choiceTerms.title")}</p>
      {groups.map(({ hash, group }) => {
        const term = value.find((v) => bytesEqual(v.group, hash)) ?? null;
        const most = Math.min(MAX_LINE_CHOICES, group.max_selections ?? group.options.length * group.max_per_option);
        return (
          <div key={bytesToHex(hash)} className="rounded-xl bg-white p-3 ring-1 ring-ink-100 dark:bg-ink-900 dark:ring-ink-800">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-ink-800 dark:text-ink-100">{group.name}</span>
              <Switch checked={term !== null} label={group.name} onChange={(on) => put(hash, on ? { group: hash, options: [], included: isSingleChoice(group) ? 1 : 0 } : null)} />
            </div>
            {term ? (
              <>
                <p className="mt-2 text-xs text-ink-400">{term.options.length > 0 ? t("choiceTerms.only") : t("choiceTerms.any")}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.options.map((option) => {
                    const on = term.options.includes(option.id);
                    return (
                      <Chip key={option.id} active={on} onClick={() => put(hash, { ...term, options: on ? term.options.filter((id) => id !== option.id) : [...term.options, option.id].sort((a, b) => a - b) })}>
                        {option.name}
                      </Chip>
                    );
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-500">{t("choiceTerms.covers")}</span>
                  <Stepper value={Math.min(term.included, most)} min={0} max={most} onChange={(included) => put(hash, { ...term, included })} />
                </div>
              </>
            ) : (
              <p className="mt-1 text-xs text-ink-400">{t("choiceTerms.open")}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
