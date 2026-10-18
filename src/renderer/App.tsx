import { lazy, Suspense, useEffect } from 'react'
import { applyEvent, api, useStore } from './state/store'
import { MediaPanel } from './panels/MediaPanel'
import { InstructionsPanel } from './panels/InstructionsPanel'
import { GitPanel } from './panels/GitPanel'
import { RunPanel } from './panels/RunPanel'
import { ChatSettings } from './panels/ChatSettings'
import { SettingsModal } from './panels/SettingsModal'
import { Welcome } from './panels/Welcome'
import { Toasts } from './panels/Toasts'
import { ToolWindows } from './tools/ToolWindow'
import { ConsentDialog } from './tools/ConsentDialog'
import { ManagePlugins } from './tools/ManagePlugins'
import { MakeTool } from './tools/MakeTool'
import { Shell } from './shell/Shell'
import { ProjectTabs } from './shell/ProjectTabs'

// the code window carries Monaco and xterm: loaded the first time it is opened, not at start-up
const IdeWindow = lazy(() => import('./ide/IdeWindow').then((m) => ({ default: m.IdeWindow })))

export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.project)
  const panel = useStore((s) => s.panel)
  const modal = useStore((s) => s.modal)
  const ide = useStore((s) => s.ide)

  useEffect(() => {
    const off = window.mm.onEvent(applyEvent)
    void api()
      .init()
      .then((r) => useStore.getState().set({ ready: true, settings: r.settings, keyed: r.keyed, project: r.project, projects: r.projects ?? [], planLimits: r.planLimits ?? [] }))
    void api()
      .pluginList()
      .then((r) => useStore.getState().set({ plugins: r.plugins, brokenPlugins: r.broken }))
    return off
  }, [])

  return (
    <div
      className="flex h-full w-full flex-col select-none"
      style={project ? undefined : { background: 'radial-gradient(ellipse at 50% -20%, rgb(124 58 237 / 0.28), transparent 60%), radial-gradient(ellipse at 100% 120%, rgb(8 145 178 / 0.16), transparent 50%), #05060f' }}
    >
      {project && <ProjectTabs />}
      {/* everything below the tabs: the project on screen, its panels and tools, and the dialogs */}
      <div className="relative min-h-0 flex-1">
      {ready && !project && <Welcome />}
      {project && (
        <>
          <Shell key={project.dir} />
          {panel === 'media' && <MediaPanel />}
          {panel === 'instructions' && <InstructionsPanel />}
          {panel === 'git' && <GitPanel />}
          {panel === 'run' && <RunPanel />}
          <ToolWindows />
          {ide !== 'closed' && (
            <Suspense fallback={null}>
              <IdeWindow />
            </Suspense>
          )}
        </>
      )}
      {modal?.kind === 'chat' && <ChatSettings key={modal.agent.id} agent={modal.agent} />}
      {modal?.kind === 'settings' && <SettingsModal initialTab={modal.tab} />}
      {modal?.kind === 'plugins' && <ManagePlugins />}
      {modal?.kind === 'make-tool' && <MakeTool key={modal.editId ?? 'new'} editId={modal.editId} />}
      <ConsentDialog />
      <Toasts />
      </div>
    </div>
  )
}
