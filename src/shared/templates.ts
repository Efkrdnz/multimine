import { parseAgentFile } from './agentFile'
import type { AgentSpec, Role } from './types'
import multimineMd from '../../templates/multimine.md?raw'
import mastermind from '../../templates/agents/mastermind.md?raw'
import planner from '../../templates/agents/planner.md?raw'
import implementer from '../../templates/agents/implementer.md?raw'
import designer from '../../templates/agents/designer.md?raw'
import brainstormer from '../../templates/agents/brainstormer.md?raw'
import contextHandler from '../../templates/agents/context-handler.md?raw'
import critic from '../../templates/agents/critic.md?raw'
import assetCreator from '../../templates/agents/asset-creator.md?raw'
import uiCreator from '../../templates/agents/ui-creator.md?raw'

export const MULTIMINE_TEMPLATE = multimineMd

const RAW: Record<Exclude<Role, 'custom'>, string> = {
  mastermind,
  planner,
  implementer,
  designer,
  brainstormer,
  'context-handler': contextHandler,
  'asset-creator': assetCreator,
  'ui-creator': uiCreator,
  critic
}

/** A fresh spec for a role, from its template. `custom` starts blank. */
export function roleTemplate(role: Role, id = role as string): AgentSpec {
  if (role === 'custom') {
    return {
      id,
      name: 'New Agent',
      role: 'custom',
      provider: 'mock',
      model: 'mock',
      effort: 'medium',
      color: '#a78bfa',
      permissions: 'read',
      mcp: [],
      gated: false,
      planMode: false,
      autoApprove: true,
      fallback: [],
      fallbackPaidOk: false,
      purpose: 'Describe what this agent is for, what it receives, and what it must report back.\n'
    }
  }
  return parseAgentFile(id, RAW[role])
}

export const ROLE_LABEL: Record<Role, string> = {
  mastermind: 'Mastermind',
  planner: 'Planner',
  implementer: 'Implementer',
  designer: 'Designer',
  brainstormer: 'Brainstormer',
  'context-handler': 'Context Handler',
  'asset-creator': 'Asset Creator',
  'ui-creator': 'UI Creator',
  critic: 'Critic',
  custom: 'Custom'
}

export const CREATABLE_ROLES: Role[] = ['planner', 'implementer', 'designer', 'brainstormer', 'context-handler', 'asset-creator', 'ui-creator', 'critic', 'custom']
