/**
 * @file App.tsx
 * @description Defines the main application component that sets up routing for different pages, manages WebSocket connections for real-time updates, and initializes notifications. It uses React Router for navigation and custom hooks for WebSocket and notification handling.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useCallback } from "react";
import { Layout } from "./components/Layout";
import { SplashScreen } from "./components/SplashScreen";
import { Dashboard } from "./pages/Dashboard";
import { KanbanBoard } from "./pages/KanbanBoard";
import { Sessions } from "./pages/Sessions";
import { SessionDetail } from "./pages/SessionDetail";
import { ActivityFeed } from "./pages/ActivityFeed";
import { Analytics } from "./pages/Analytics";
import { Workflows } from "./pages/Workflows";
import { Settings } from "./pages/Settings";
import { CcConfig } from "./pages/CcConfig";
import { Run } from "./pages/Run";
import { Chat } from "./pages/Chat";
import { Scheduled } from "./pages/Scheduled";
import { Missions } from "./pages/Missions";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Notes } from "./pages/Notes";
import { Vault } from "./pages/Vault";
import { Skills } from "./pages/Skills";
import { GitHubPanel } from "./pages/GitHubPanel";
import { MondayPanel } from "./pages/MondayPanel";
import { Today } from "./pages/Today";
import { Finance } from "./pages/Finance";
import { Briefings } from "./pages/Briefings";
import Browse from "./pages/Browse";
import ComputerUse from "./pages/ComputerUse";
import { LEGACY_SURFACES } from "./lib/legacy";
import { Wall } from "./pages/Wall";
import { NotFound } from "./pages/NotFound";
import { useWebSocket } from "./hooks/useWebSocket";
import { useNotifications } from "./hooks/useNotifications";
import { eventBus } from "./lib/eventBus";
import { BrainLockGate } from "./components/BrainLockGate";
import type { WSMessage } from "./lib/types";

export default function App() {
  return (
    <BrainLockGate>
      <UnlockedApp />
    </BrainLockGate>
  );
}

function UnlockedApp() {
  const onMessage = useCallback((msg: WSMessage) => {
    eventBus.publish(msg);
  }, []);

  const { connected } = useWebSocket(onMessage);
  useNotifications();

  return (
    <>
      <SplashScreen />
      <BrowserRouter>
        <Routes>
          {/* TV wall mode (Phase U): chrome-free and read-only, so it lives
              outside Layout (no sidebar, no Tabby, no mobile tab bar). */}
          <Route path="wall" element={<Wall />} />
          <Route element={<Layout wsConnected={connected} />}>
            <Route index element={<Dashboard />} />
            <Route path="kanban" element={<KanbanBoard />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:id" element={<SessionDetail />} />
            <Route path="activity" element={<ActivityFeed />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="cc-config" element={<CcConfig />} />
            <Route path="run" element={<Run />} />
            <Route path="chat" element={<Chat />} />
            <Route path="scheduled" element={<Scheduled />} />
            <Route path="missions" element={<Missions />} />
            <Route path="missions/:id" element={<Missions />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/:id" element={<ProjectDetail />} />
            <Route path="notes" element={<Notes />} />
            <Route path="vault" element={<Vault />} />
            <Route path="vault/graph" element={<Vault />} />
            <Route path="skills" element={<Skills />} />
            <Route path="github" element={<GitHubPanel />} />
            <Route path="monday" element={<MondayPanel />} />
            <Route path="today" element={<Today />} />
            <Route path="finance" element={<Finance />} />
            <Route path="briefings" element={<Briefings />} />
            {/* Phase AF: Phase-Z surfaces retired in favour of RustDesk /
                ChatGPT Work - parked one release behind LEGACY_SURFACES=1,
                then deleted for real. */}
            {LEGACY_SURFACES && <Route path="browse" element={<Browse />} />}
            {LEGACY_SURFACES && <Route path="computer-use" element={<ComputerUse />} />}
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  );
}
