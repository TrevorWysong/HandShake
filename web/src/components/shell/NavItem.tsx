import { NavLink } from "react-router-dom";
import clsx from "clsx";
import type { Home } from "lucide-react";

/// Where the navigation sits: the bottom bar on a phone, the sidebar on a
/// wide screen.
export type NavPlacement = "bar" | "side";

/// One place in the navigation, with an optional count badge.
export function NavItem({ to, icon: Icon, label, badge, placement }: { to: string; icon: typeof Home; label: string; badge?: number; placement: NavPlacement }) {
  const count = !!badge && (
    <span
      className={clsx(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-handshake-500 px-1 text-[10px] font-bold text-white",
        placement === "bar" ? "absolute -top-1.5 -right-2" : "ml-auto",
      )}
    >
      {badge}
    </span>
  );
  if (placement === "side") {
    return (
      <NavLink
        to={to}
        end
        className={({ isActive }) =>
          clsx(
            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition",
            isActive ? "bg-handshake-50 text-handshake-700 dark:bg-handshake-900/30 dark:text-handshake-300" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-white",
          )
        }
      >
        <Icon size={19} strokeWidth={2.25} />
        {label}
        {count}
      </NavLink>
    );
  }
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        clsx(
          "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition",
          isActive ? "text-handshake-600 dark:text-handshake-400" : "text-ink-400 dark:text-ink-500"
        )
      }
    >
      <div className="relative">
        <Icon size={22} strokeWidth={2.25} />
        {count}
      </div>
      {label}
    </NavLink>
  );
}
