/**
 * @file Layout.tsx
 * @description Defines the Layout component that serves as the main structure for the application, including a collapsible sidebar and a main content area. The sidebar's collapsed state is stored in localStorage to persist user preferences across sessions. The component uses React Router's Outlet to render nested routes within the main content area and adjusts its layout based on the sidebar's state.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useState, useCallback, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar, SIDEBAR_STORAGE_KEY, loadCollapsed } from "./Sidebar";
import { UpdateNotifier } from "./UpdateNotifier";
import { Tabby } from "./Tabby/Tabby";
import { UltronTakeover } from "./UltronTakeover";
import { hudMode, installIncantationListener, installDevBridge } from "../lib/hudMode";
import { eventBus } from "../lib/eventBus";
import type { Agent, Session, WSMessage } from "../lib/types";

interface LayoutProps {
  wsConnected: boolean;
}

export function Layout({ wsConnected }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  // HUD personality: initialise from the persisted setting, listen for the
  // typed incantations, and feed live agent/session activity into the
  // automatic ULTRON triggers (error storm, swarm).
  useEffect(() => {
    hudMode.init();
    // Dev-only console handle (window.__hud) for exercising modes/triggers.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) installDevBridge();
    const removeKeys = installIncantationListener();
    const unsubscribe = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "agent_created" || msg.type === "agent_updated") {
        const agent = msg.data as Agent;
        if (agent && typeof agent.id === "string" && typeof agent.status === "string") {
          hudMode.reportAgentStatus(agent.id, agent.status);
          if (agent.status === "error") hudMode.reportError();
        }
      } else if (msg.type === "session_updated") {
        const session = msg.data as Session;
        if (session && session.status === "error") hudMode.reportError();
      }
    });
    return () => {
      removeKeys();
      unsubscribe();
    };
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  return (
    <div className="min-h-screen">
      <UltronTakeover />
      <UpdateNotifier />
      <Tabby />
      <Sidebar wsConnected={wsConnected} collapsed={collapsed} onToggle={toggle} />
      <main
        className="min-h-screen min-w-0 transition-[margin-left,width] duration-200"
        style={{
          marginLeft: collapsed ? "4.25rem" : "15rem",
          width: collapsed ? "calc(100% - 4.25rem)" : "calc(100% - 15rem)",
        }}
      >
        {/* overflow-x-clip (not -hidden) clips horizontal overflow without
            creating a scroll container, so descendant `position: sticky`
            elements (e.g. the Settings page TOC) still pin to the window. */}
        <div className="p-5 lg:p-6 max-w-full overflow-x-clip">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
