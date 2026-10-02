import { lazy, Suspense, useEffect, useState } from 'react'
import { applyEvent, api, useStore } from './state/store'
import { SpaceView } from './space/SpaceView'
import { TopBar } from './panels/TopBar'
import { LeftRail } from './panels/LeftRail'
import { ChatDock } from './panels/ChatDock'
import { InboxPanel } from './panels/InboxPanel'
import { MediaPanel } from './panels/MediaPanel'
import { ContextPanel } from './panels/ContextPanel'
import { GitPanel } from './panels/GitPanel'
import { AgentEditor } from './panels/AgentEditor'
import { SettingsModal } from './panels/SettingsModal'
import { Welcome } from './panels/Welcome'
import { Toasts } from './panels/Toasts'
import { TeamWizard } from './panels/TeamWizard'
import { ToolWindows } from './tools/ToolWindow'
import { ConsentDialog } from './tools/ConsentDialog'
import { ManagePlugins } from './tools/ManagePlugins'

// the code window carries Monaco and xterm: loaded the first time it is opened, not at start-up
const IdeWindow = lazy(() => import('./ide/IdeWindow').then((m) => ({ default: m.IdeWindow })))

export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.project)
  const panel = useStore((s) => s.panel)
  const modal = useStore((s) => s.modal)
  const ide = useStore((s) => s.ide)
  // offered once per opened project, when it has nobody but Mastermind; stays up until finished
  const [wizard, setWizard] = useState(false)
  const projectDir = project?.dir
  const lonely = !!project && project.agents.length === 1
  useEffect(() => {
    if (projectDir && lonely) setWizard(true)
    // only re-decide when another project is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    const off = window.mm.onEvent(applyEvent)
    void api()
      .init()
      .then((r) => useStore.getState().set({ ready: true, settings: r.settings, keyed: r.keyed, project: r.project }))
    void api()
      .pluginList()
      .then((r) => useStore.getState().set({ plugins: r.plugins, brokenPlugins: r.broken }))
    return off
  }, [])

  return (
    <div className="relative h-full w-full select-none">
      <SpaceView />
      {ready && !project && <Welcome />}
      {project && (
        <>
          <TopBar />
          <LeftRail />
          <ChatDock />
          {panel === 'inbox' && <InboxPanel />}
          {panel === 'media' && <MediaPanel />}
          {panel === 'context' && <ContextPanel />}
          {panel === 'git' && <GitPanel />}
          <ToolWindows />
          {ide !== 'closed' && (
            <Suspense fallback={null}>
              <IdeWindow />
            </Suspense>
          )}
          {wizard && !modal && <TeamWizard onDone={() => setWizard(false)} />}
        </>
      )}
      {modal?.kind === 'agent' && <AgentEditor key={modal.agent.id || 'new'} agent={modal.agent} isNew={modal.isNew} />}
      {modal?.kind === 'settings' && <SettingsModal initialTab={modal.tab} />}
      {modal?.kind === 'plugins' && <ManagePlugins />}
      <ConsentDialog />
      <Toasts />
    </div>
  )
}
