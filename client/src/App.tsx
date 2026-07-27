/**
 * @file App.tsx
 * @description Defines the main application component that sets up routing for different pages, manages WebSocket connections for real-time updates, and initializes notifications. It uses React Router for navigation and custom hooks for WebSocket and notification handling.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { lazy, Suspense, useCallback } from "react";
import { Layout } from "./components/Layout";
import { SplashScreen } from "./components/SplashScreen";
import { LEGACY_SURFACES } from "./lib/legacy";
import { useWebSocket } from "./hooks/useWebSocket";
import { useNotifications } from "./hooks/useNotifications";
import { eventBus } from "./lib/eventBus";
import type { WSMessage } from "./lib/types";

const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const KanbanBoard = lazy(() =>
  import("./pages/KanbanBoard").then((m) => ({ default: m.KanbanBoard }))
);
const Sessions = lazy(() => import("./pages/Sessions").then((m) => ({ default: m.Sessions })));
const SessionDetail = lazy(() =>
  import("./pages/SessionDetail").then((m) => ({ default: m.SessionDetail }))
);
const ActivityFeed = lazy(() =>
  import("./pages/ActivityFeed").then((m) => ({ default: m.ActivityFeed }))
);
const Analytics = lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })));
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const CcConfig = lazy(() => import("./pages/CcConfig").then((m) => ({ default: m.CcConfig })));
const Run = lazy(() => import("./pages/Run").then((m) => ({ default: m.Run })));
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
const Scheduled = lazy(() => import("./pages/Scheduled").then((m) => ({ default: m.Scheduled })));
const Missions = lazy(() => import("./pages/Missions").then((m) => ({ default: m.Missions })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() =>
  import("./pages/ProjectDetail").then((m) => ({ default: m.ProjectDetail }))
);
const Notes = lazy(() => import("./pages/Notes").then((m) => ({ default: m.Notes })));
const Vault = lazy(() => import("./pages/Vault").then((m) => ({ default: m.Vault })));
const Skills = lazy(() => import("./pages/Skills").then((m) => ({ default: m.Skills })));
const GitHubPanel = lazy(() =>
  import("./pages/GitHubPanel").then((m) => ({ default: m.GitHubPanel }))
);
const MondayPanel = lazy(() =>
  import("./pages/MondayPanel").then((m) => ({ default: m.MondayPanel }))
);
const Today = lazy(() => import("./pages/Today").then((m) => ({ default: m.Today })));
const Finance = lazy(() => import("./pages/Finance").then((m) => ({ default: m.Finance })));
const Briefings = lazy(() => import("./pages/Briefings").then((m) => ({ default: m.Briefings })));
const Browse = lazy(() => import("./pages/Browse"));
const ComputerUse = lazy(() => import("./pages/ComputerUse"));
const Wall = lazy(() => import("./pages/Wall").then((m) => ({ default: m.Wall })));
const NotFound = lazy(() => import("./pages/NotFound").then((m) => ({ default: m.NotFound })));

export default function App() {
  const onMessage = useCallback((msg: WSMessage) => {
    eventBus.publish(msg);
  }, []);

  const { connected } = useWebSocket(onMessage);
  useNotifications();

  return (
    <>
      <SplashScreen />
      <BrowserRouter>
        <Suspense fallback={<div className="p-8 text-sm text-gray-500">Loading…</div>}>
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
              {/* The old headless browse surface stays parked; real Mac computer
                control is active again behind its Settings permission gate. */}
              {LEGACY_SURFACES && <Route path="browse" element={<Browse />} />}
              <Route path="computer-use" element={<ComputerUse />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </>
  );
}
