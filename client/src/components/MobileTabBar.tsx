/**
 * @file MobileTabBar.tsx
 * @description Mobile home-screen chrome — a fixed bottom tab bar replacing
 *   the hamburger-drawer navigation model on small screens (desktop keeps
 *   the collapsible Sidebar). Covers the highest-traffic routes directly;
 *   everything else (Analytics, Workflows, cc-config, Run, Settings) stays
 *   reachable via "More", which opens the existing nav drawer.
 */

import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LayoutDashboard, Columns3, FolderOpen, Activity, Menu } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface MobileTabBarProps {
  onMore: () => void;
}

const TABS: ReadonlyArray<{ to: string; icon: LucideIcon; key: string }> = [
  { to: "/", icon: LayoutDashboard, key: "nav:dashboard" },
  { to: "/kanban", icon: Columns3, key: "nav:agentBoard" },
  { to: "/sessions", icon: FolderOpen, key: "nav:sessions" },
  { to: "/activity", icon: Activity, key: "nav:activityFeed" },
];

export function MobileTabBar({ onMore }: MobileTabBarProps) {
  const { t } = useTranslation();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-20 h-16 bg-surface-1 border-t border-border flex items-stretch"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map(({ to, icon: Icon, key }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
              isActive ? "text-accent" : "text-gray-500 hover:text-gray-300"
            }`
          }
        >
          <Icon className="w-5 h-5" aria-hidden />
          <span className="truncate max-w-full px-0.5">{t(key)}</span>
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMore}
        aria-label={t("nav:more", "More")}
        className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-gray-500 hover:text-gray-300 transition-colors"
      >
        <Menu className="w-5 h-5" aria-hidden />
        <span>{t("nav:more", "More")}</span>
      </button>
    </nav>
  );
}
