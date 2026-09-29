import { lazyWithReload as lazy } from '../../lib/lazyWithReload'

// Off the first-screen graph (spec v3 M27): these are opened on demand.
// lazyWithReload: a post-deploy chunk 404 reloads once instead of white-screening (A1).
export const FileBrowser = lazy(() => import('../FileBrowser'))
export const GitViewer = lazy(() => import('../GitViewer'))
export const AgentDashboard = lazy(() => import('../AgentDashboard'))
export const RunMetricsPanel = lazy(() => import('../RunMetricsPanel').then(m => ({ default: m.RunMetricsPanel })))
export const VaultReader = lazy(() => import('../VaultReader'))
export const MemoryPanel = lazy(() => import('../MemoryPanel'))
export const AdminPanel = lazy(() => import('../AdminPanel'))
export const ScheduledTasksPanel = lazy(() => import('../ScheduledTasksPanel'))
export const PushSettings = lazy(() => import('../PushSettings'))
export const PromptsSheet = lazy(() => import('../PromptsSheet'))
