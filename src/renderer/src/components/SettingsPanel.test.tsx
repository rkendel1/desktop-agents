// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, Conversation, DouchatApi, LocalAgent, Routine } from '../../../shared/types'

vi.mock('../preferences', () => ({
  setPreferences: vi.fn(),
  usePreferences: () => ({ language: 'en', appearance: 'system', fontSize: 1 }),
  t: (text: string) => text
}))

vi.mock('./common', () => ({
  UserAvatar: ({ name }: { name: string }) => <span data-user-avatar={name} />,
  AgentAvatar: ({ agent }: { agent: AgentConfig }) => <span data-agent-avatar={agent.id} />,
  ConversationAvatar: ({ conversation }: { conversation: Conversation }) => <span data-conversation-avatar={conversation.id} />,
  EmptyAvatar: () => <span data-empty-avatar />,
  agentDisplayName: (agent: AgentConfig) => agent.name,
  conversationDisplayName: (conversation: Conversation, agents: AgentConfig[]) => conversation.type === 'direct'
    ? agents.find((agent) => agent.id === conversation.agentIds[0])?.name ?? conversation.name
    : conversation.name
}))

import { SettingsPanel } from './SettingsPanel'

describe('settings panel', () => {
  let container: HTMLDivElement
  let root: Root
  let getUsageSummary: ReturnType<typeof vi.fn>
  let openSubscriptionPlans: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    getUsageSummary = vi.fn(async () => ({ planName: 'Free', status: 'free', credits: 1611 }))
    openSubscriptionPlans = vi.fn(async () => undefined)
    Object.defineProperty(window, 'douchat', {
      configurable: true,
      value: { getUsageSummary, openSubscriptionPlans } as Partial<DouchatApi>
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderGeneral(): Promise<void> {
    await act(async () => root.render(
      <SettingsPanel
        user={{ name: 'Ada', image: '' }}
        agents={[]}
        scanning={false}
        error=""
        tab="general"
        onTab={vi.fn()}
        onClose={vi.fn()}
        onUpdateProfile={vi.fn(async () => undefined)}
        onDetect={vi.fn()}
      />
    ))
  }

  async function renderAgents(agents: LocalAgent[]): Promise<void> {
    await act(async () => root.render(
      <SettingsPanel
        user={{ name: 'Ada', image: '' }}
        agents={agents}
        scanning={false}
        error=""
        tab="agents"
        onTab={vi.fn()}
        onClose={vi.fn()}
        onUpdateProfile={vi.fn(async () => undefined)}
        onDetect={vi.fn()}
      />
    ))
  }

  async function renderAutomation(
    routines: Routine[],
    onSetRoutineEnabled: (id: string, enabled: boolean) => Promise<void>,
    workspaceAgents: AgentConfig[] = [],
    conversations: Conversation[] = []
  ): Promise<void> {
    await act(async () => root.render(
      <SettingsPanel
        user={{ name: 'Ada', image: '' }}
        agents={[]}
        routines={routines}
        workspaceAgents={workspaceAgents}
        conversations={conversations}
        scanning={false}
        error=""
        tab="automation"
        onTab={vi.fn()}
        onClose={vi.fn()}
        onUpdateProfile={vi.fn(async () => undefined)}
        onDetect={vi.fn()}
        onSetRoutineEnabled={onSetRoutineEnabled}
      />
    ))
  }

  it('defers dialog focus until after mount and restores the opener on dismissal', async () => {
    vi.useFakeTimers()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    try {
      await renderGeneral()
      expect(document.activeElement).toBe(opener)
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(container.querySelector('.settings-close'))
      await act(async () => root.render(null))
      expect(document.activeElement).toBe(opener)
      await act(async () => { vi.runAllTimers() })
      expect(document.activeElement).toBe(opener)
    } finally { opener.remove(); vi.useRealTimers() }
  })

  it('offers follow-system alongside the explicit interface languages', async () => {
    await renderGeneral()

    const language = container.querySelector<HTMLSelectElement>('.general-settings select')
    expect([...language?.options ?? []].map((option) => [option.value, option.textContent])).toEqual([
      ['system', 'Follow system'],
      ['en', 'English'],
      ['zh-CN', '简体中文']
    ])
  })

  it('shows one-time automations and lets the user pause them', async () => {
    const onSetRoutineEnabled = vi.fn(async () => undefined)
    const runAt = Date.now() + 5 * 60_000
    const contact = {
      id: 'agent-1', name: 'Water Buddy', role: 'Assistant', instructions: '', color: '#14B8A6', provider: '', model: '', avatarSeed: 'water-buddy', createdAt: 1
    } satisfies AgentConfig
    const conversation = {
      id: 'conversation-1', type: 'direct', name: 'Old stored name', agentIds: [contact.id], topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 1, updatedAt: 1
    } satisfies Conversation
    await renderAutomation([{
      id: 'routine-1',
      name: 'Drink water',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      prompt: 'Remind the user to drink water.',
      target: 'local',
      schedule: { kind: 'once', runAt },
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: runAt,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }], onSetRoutineEnabled, [contact], [conversation])

    expect(container.querySelector('#automation-tab')?.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('Drink water')
    expect(container.textContent).toContain('Once')
    expect(container.querySelector('[data-conversation-avatar="conversation-1"]')).not.toBeNull()
    expect(container.querySelector('.automation-row-contact-name')?.textContent).toBe('Water Buddy')
    expect(container.querySelector('.automation-row-meta')?.textContent).not.toContain('Old stored name')
    expect(container.querySelector('.automation-row-icon')).toBeNull()
    expect(container.querySelectorAll('.automation-row-meta > span')[1]?.textContent).toBe('Once')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!.click())
    expect(onSetRoutineEnabled).toHaveBeenCalledWith('routine-1', false)
  })

  it('shows ready CLIs, desktop-only apps, and missing supported agents separately', async () => {
    await renderAgents([
      { id: 'codex', name: 'Codex', command: 'codex', installed: true, discovered: true, path: '/bin/codex', version: 'codex 1.2.3', chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'claude', name: 'Claude Code', command: 'claude', installed: false, discovered: true, desktopPath: '/Applications/Claude.app', chatSupported: true, status: 'desktop-only', authentication: 'unchecked' },
      { id: 'gemini', name: 'Gemini', command: 'gemini', installed: false, discovered: false, chatSupported: true, status: 'not-found', authentication: 'unchecked' }
    ])

    expect(container.textContent).toContain('1.2.3')
    expect(container.querySelector('.local-agent-version')?.textContent).toBe('1.2.3')
    expect(container.querySelector('.local-agent-version')?.getAttribute('title')).toBe('codex 1.2.3')
    expect(container.textContent).not.toContain('Ready for chat')
    expect(container.textContent).not.toContain('login checked when first used')
    expect(container.textContent).toContain('/Applications/Claude.app')
    expect(container.textContent).not.toContain('CLI command not found: claude')
    expect(container.textContent).not.toContain('Expected CLI command: gemini')
  })

  it('keeps custom agent registration out of the settings list', async () => {
    await renderAgents([])
    expect(container.querySelector('.local-agent-add')).toBeNull()
    expect(container.querySelector('input[aria-label="Agent name"]')).toBeNull()
    expect(container.textContent).not.toContain('Custom local agent')
  })

  it('offers diagnostic logs alongside version controls and the website', async () => {
    const update = { status: 'disabled' as const, currentVersion: '0.1.6' }
    Object.defineProperty(window, 'douchat', {
      configurable: true,
      value: {
        openDiagnosticLogs: vi.fn(async () => undefined),
        getUpdateState: vi.fn(async () => update),
        onUpdateState: vi.fn(() => () => undefined),
        checkForUpdates: vi.fn(async () => update),
        installUpdate: vi.fn(async () => update)
      } as Partial<DouchatApi>
    })
    await act(async () => root.render(
      <SettingsPanel
        user={{ name: 'Ada', image: '' }}
        agents={[]}
        scanning={false}
        error=""
        tab="about"
        onTab={vi.fn()}
        onClose={vi.fn()}
        onUpdateProfile={vi.fn(async () => undefined)}
        onDetect={vi.fn()}
      />
    ))

    expect(container.textContent).toContain('0.1.6')
    expect(container.textContent).toContain('Software update')
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://github.com/thinkany-ai/douchat"]')?.textContent).toBe('Source code')
    expect(container.textContent).toContain('AGPL-3.0-only license')
    expect(container.querySelector<HTMLAnchorElement>('a.about-website-button')?.href).toBe('https://douchat.ai/?utm_source=douchat-desktop')
    const logs = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Open log folder')!
    await act(async () => logs.click())
    expect(window.douchat.openDiagnosticLogs).toHaveBeenCalledOnce()
    expect(container.querySelector('.about-note')).toBeNull()
    expect(container.textContent).not.toContain('Updates are downloaded from signed Foundry releases')
  })

})

// Component behavior tests use an inline host; NativeDialog has separate window lifecycle tests.
vi.mock('./NativeDialog', async () => {
  const { createElement } = await import('react')
  return { NativeDialog: ({ children, onClose, width, height, ...props }: any) => createElement('div', props, children) }
})
