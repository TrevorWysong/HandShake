// How the app looks: as the device does (the default), or always light or
// dark -- where the big apps keep it, among the account's settings.
import { Moon, Palette, Smartphone, Sun, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { usePreferences, type Theme } from "../../store/preferences";
import { useT, type MessageKey } from "../../i18n";
import { Card } from "../ui";

const CHOICES: { theme: Theme; icon: LucideIcon; label: MessageKey }[] = [
  { theme: "system", icon: Smartphone, label: "appearance.system" },
  { theme: "light", icon: Sun, label: "appearance.light" },
  { theme: "dark", icon: Moon, label: "appearance.dark" },
];

export function AppearanceSettings() {
  const t = useT();
  const theme = usePreferences((s) => s.theme);
  const setTheme = usePreferences((s) => s.setTheme);
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center gap-3">
        <Palette size={18} className="shrink-0 text-ink-400" />
        <span className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("appearance.title")}</span>
      </div>
      <div role="radiogroup" aria-label={t("appearance.title")} className="grid grid-cols-3 gap-1 rounded-2xl bg-ink-100 p-1 dark:bg-ink-800">
        {CHOICES.map(({ theme: choice, icon: Icon, label }) => {
          const on = theme === choice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setTheme(choice)}
              className={clsx(
                "flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-xs font-semibold transition",
                on ? "bg-white text-ink-900 shadow-sm dark:bg-ink-950 dark:text-white" : "text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100",
              )}
            >
              <Icon size={17} className={on ? "text-handshake-500" : undefined} />
              {t(label)}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
