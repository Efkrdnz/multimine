import { useEffect, useRef } from 'react'
import { MASTERMIND_ID } from '@shared/types'
import { api, onSceneEvent, useStore } from '../state/store'
import { SpaceStage, type SceneState } from './SpaceStage'
import { Balloons } from './Balloons'

/** Hosts the Pixi scene and feeds it the store. */
export function SpaceView() {
  const host = useRef<HTMLDivElement>(null)
  const stageRef = useRef<SpaceStage | null>(null)

  useEffect(() => {
    const stage = new SpaceStage({
      open: (id) => useStore.getState().openChat(id),
      edit: (id) => {
        const agent = useStore.getState().project?.agents.find((a) => a.id === id)
        if (agent) useStore.getState().set({ modal: { kind: 'agent', agent, isNew: false } })
      },
      move: (id, x, y) => void api().setPosition(id, x, y)
    })
    stageRef.current = stage
    let disposed = false
    void stage.mount(host.current!).then(() => {
      if (disposed) stage.destroy()
    })
    const pick = (s: ReturnType<typeof useStore.getState>): SceneState => ({
      agents: s.project?.agents ?? [],
      layout: s.project?.layout ?? {},
      status: s.status,
      pending: s.inbox.filter((i) => i.status === 'pending').length,
      council: s.council,
      channels: s.channels,
      focused: s.focused,
      catalog: s.settings?.catalog ?? {}
    })
    stage.sync(pick(useStore.getState()))
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project !== prev.project || s.status !== prev.status || s.inbox !== prev.inbox || s.council !== prev.council || s.channels !== prev.channels || s.focused !== prev.focused || s.settings !== prev.settings)
        stage.sync(pick(s))
    })
    const off = onSceneEvent((e) => stage.event(e))
    return () => {
      disposed = true
      unsub()
      off()
      try {
        stage.destroy()
      } catch {
        // not mounted yet
      }
    }
  }, [])

  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      if (s.focused && s.focused !== prev.focused && s.focused !== MASTERMIND_ID) stageRef.current?.focus(s.focused)
    })
  }, [])

  return (
    <>
      <div ref={host} className="absolute inset-0" data-testid="space" />
      <Balloons stage={stageRef} />
    </>
  )
}
