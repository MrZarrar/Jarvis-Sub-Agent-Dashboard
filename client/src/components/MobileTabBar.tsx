/**
 * @file MobileTabBar.tsx
 * @description Mobile home-screen chrome - a fixed bottom tab bar replacing
 *   the hamburger-drawer navigation model on small screens (desktop keeps
 *   the collapsible Sidebar). Phase R re-architected the tabs around what a
 *   phone is actually for: Home, Agents (kanban), a center Jarvis button that
 *   opens the Tabby assistant sheet (the mobile front door - most phone
 *   interactions should be "ask Jarvis", not navigate-and-tap), and Notes.
 *   Everything else (Sessions, Activity, Analytics, Run, Settings, …) stays
 *   reachable via "More", which opens the existing nav drawer.
 */

import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LayoutDashboard, Orbit, NotebookPen, Menu, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { tabbyPrefs } from "./Tabby/prefs";

interface MobileTabBarProps {
  onMore: () => void;
}

// Dashboard is the phone's default surface; its mission deck links to Today.
const LEFT_TABS: ReadonlyArray<{ to: string; icon: LucideIcon; key: string }> = [
  { to: "/", icon: LayoutDashboard, key: "nav:dashboard" },
  { to: "/missions", icon: Orbit, key: "nav:missions" },
];

const RIGHT_TABS: ReadonlyArray<{ to: string; icon: LucideIcon; key: string }> = [
  { to: "/notes", icon: NotebookPen, key: "nav:notes" },
];

export function MobileTabBar({ onMore }: MobileTabBarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
      isActive ? "text-accent" : "text-gray-500 hover:text-gray-300"
    }`;

  const renderTab = ({ to, icon: Icon, key }: { to: string; icon: LucideIcon; key: string }) => (
    <NavLink key={to} to={to} end={to === "/"} className={tabClass}>
      <Icon className="w-5 h-5" aria-hidden />
      <span className="truncate max-w-full px-0.5">{t(key)}</span>
    </NavLink>
  );

  // The center Jarvis button opens the Tabby assistant bottom sheet. When the
  // companion is disabled in Settings, it falls back to the full Chat page so
  // the tab never dead-ends.
  const onJarvis = () => {
    if (tabbyPrefs.getEnabled()) {
      window.dispatchEvent(new CustomEvent("tabby:open"));
    } else {
      navigate("/chat");
    }
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-20 h-16 bg-surface-1 border-t border-border flex items-stretch"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {LEFT_TABS.map(renderTab)}
      <button
        type="button"
        onClick={onJarvis}
        aria-label={t("nav:jarvis", "Jarvis")}
        className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="w-9 h-9 -mt-3 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center shadow-[0_0_12px_rgba(0,194,232,0.35)]">
          <Sparkles className="w-4.5 h-4.5 text-accent" aria-hidden />
        </span>
        <span>{t("nav:jarvis", "Jarvis")}</span>
      </button>
      {RIGHT_TABS.map(renderTab)}
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
