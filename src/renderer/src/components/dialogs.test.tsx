// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, Conversation, LocalAgent } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text,
  tr: (text: string) => text
}))

vi.mock('./common', () => ({
  UserAvatar: ({ name }: { name: string }) => <span data-user-avatar={name} />,
  AgentAvatar: ({ agent }: { agent: AgentConfig }) => <span data-avatar={agent.id} />,
  ConversationAvatar: ({ conversation }: { conversation: Conversation }) => <span data-conversation-avatar={conversation.id} />,
  agentDisplayName: (agent: AgentConfig) => agent.name,
  conversationDisplayName: (conversation: Conversation) => conversation.name,
  colors: ['#14B8A6', '#FF5DA8', '#7C6CF2']
}))

import { AddMembersModal, BotModal, GroupModal } from './dialogs'

const agents: AgentConfig[] = [
  { id: 'alpha', name: 'Alpha', role: '', instructions: '', color: '#14B8A6', provider: '', model: '', createdAt: 1 },
  { id: 'beta', name: 'Beta', role: '', instructions: '', color: '#7C6CF2', provider: '', model: '', createdAt: 2 }
]

const conversation = (input: Partial<Conversation> & Pick<Conversation, 'id' | 'type' | 'name' | 'agentIds'>): Conversation => ({
  topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 1, updatedAt: 1, ...input
})

const snapshot = {
  agents,
  conversations: [
    conversation({ id: 'direct-alpha', type: 'direct', name: 'Alpha', agentIds: ['alpha'] }),
    conversation({ id: 'group-team', type: 'group', name: 'Team room', agentIds: ['alpha', 'beta'], leadAgentId: 'alpha' })
  ]
} as AppSnapshot

describe('start chat picker', () => {
  let container: HTMLDivElement
  let root: Root
  let onCreate: ReturnType<typeof vi.fn>
  let onStartDirect: ReturnType<typeof vi.fn>
  let onOpenConversation: ReturnType<typeof vi.fn>
  let renderId: number

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onCreate = vi.fn(async () => undefined)
    onStartDirect = vi.fn(async () => undefined)
    onOpenConversation = vi.fn(async () => undefined)
    renderId = 0
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderPicker(initialAgentIds?: string[]): Promise<void> {
    await act(async () => root.render(
      <GroupModal
        key={++renderId}
        snapshot={snapshot}
        initialAgentIds={initialAgentIds}
        onClose={vi.fn()}
        onCreate={onCreate}
        onStartDirect={onStartDirect}
        onOpenConversation={onOpenConversation}
        onUpdate={vi.fn(async () => undefined)}
        onNewBot={vi.fn()}
      />
    ))
  }

  const row = (name: string): HTMLButtonElement => {
    const match = [...container.querySelectorAll<HTMLButtonElement>('.member-picker-row')]
      .find((button) => button.textContent?.includes(name))
    if (!match) throw new Error(`Missing row: ${name}`)
    return match
  }

  const primary = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button.primary-button')!

  it('opens an existing group instead of creating another one', async () => {
    await renderPicker()
    const groups = [...container.querySelectorAll<HTMLButtonElement>('.member-picker-folder')]
      .find((button) => button.textContent?.includes('Existing groups'))!
    await act(async () => groups.click())
    await act(async () => row('Team room').click())
    expect(primary().textContent).toBe('Open group')

    await act(async () => primary().click())
    expect(onOpenConversation).toHaveBeenCalledWith('group-team')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('opens or starts a direct chat when one contact is selected', async () => {
    await renderPicker()
    await act(async () => row('Alpha').click())
    expect(primary().textContent).toBe('Open chat')
    await act(async () => primary().click())
    expect(onOpenConversation).toHaveBeenCalledWith('direct-alpha')
    expect(onStartDirect).not.toHaveBeenCalled()

    await renderPicker()
    await act(async () => row('Beta').click())
    expect(primary().textContent).toBe('Start chat')
    await act(async () => primary().click())
    expect(onStartDirect).toHaveBeenCalledWith('beta')
  })

  it('creates a group when several contacts are selected', async () => {
    await renderPicker()
    await act(async () => row('Alpha').click())
    await act(async () => row('Beta').click())
    expect(primary().textContent).toBe('Create group')

    await act(async () => primary().click())
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['alpha', 'beta'], leadAgentId: 'alpha' }))
    expect(onStartDirect).not.toHaveBeenCalled()
  })

  it('still requires another contact when converting a direct chat into a group', async () => {
    await renderPicker(['alpha'])
    expect(container.querySelector('h2')?.textContent).toBe('Create group')
    expect(primary().disabled).toBe(true)

    await act(async () => row('Beta').click())
    expect(primary().disabled).toBe(false)
    expect(primary().textContent).toBe('Create group')
  })
})

describe('create agent terminology', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('separates the created agent from its model service or local agent', async () => {
    await act(async () => root.render(
      <BotModal
        localAgents={[]}
        onSettings={vi.fn()}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={vi.fn(async () => undefined)}
      />
    ))

    expect(container.textContent).toContain('Create agent')
    expect(container.textContent).toContain('Agent name')
    expect(container.textContent).toContain('Runs with')
    expect(container.textContent).toContain('Custom model')
    expect(container.textContent).toContain('Local agent')
    expect(container.textContent).not.toContain('Create contact')
    expect([...container.querySelectorAll('[aria-label="Runs with"] [role="radio"] strong')].map(button => button.textContent)).toEqual(['Custom model', 'Local agent'])
    expect([...container.querySelectorAll('[aria-label="Claude"] [role="radio"] strong')].map(button => button.textContent)).toEqual(['Claude Code', 'Anthropic API'])

    const local = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes('Local agent'))!
    await act(async () => local.click())

    expect(container.textContent).toContain('Local agent')
    expect(container.textContent).toContain('No available local agents')
  })

  it('creates an agent with a saved custom model without exposing its key', async () => {
    Object.defineProperty(window, 'douchat', { configurable: true, value: {
      getCustomModels: vi.fn(async () => ({ providers: [{ id: 'mine', name: 'Mine', kind: 'openai', apiBase: 'https://example.com', hasKey: true, models: ['org/model'] }], defaultModel: 'mine/org/model' }))
    } })
    const onCreate = vi.fn(async () => undefined)
    await act(async () => root.render(<BotModal localAgents={[]} onSettings={vi.fn()} onClose={vi.fn()} onCreate={onCreate} onUpdate={vi.fn()} />))
    const custom = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(b => b.textContent?.includes('Custom model'))!
    await act(async () => custom.click())
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Custom model"]')?.value).toBe('default')
    expect(container.querySelector('[aria-label="Custom model"]')?.textContent).toContain('Default model')
    const name = container.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'My agent')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ customModel: { providerId: '@default', model: 'default' }, localAgentId: '' }))
    expect(JSON.stringify(onCreate.mock.calls)).not.toContain('apiKey')
  })

  it('creates a manual agent with a blank description by default', async () => {
    const onCreate = vi.fn(async () => undefined)
    await act(async () => root.render(
      <BotModal
        localAgents={[]}
        onSettings={vi.fn()}
        onClose={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn(async () => undefined)}
      />
    ))

    const name = container.querySelector<HTMLInputElement>('.field-row input')!
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name), 'value')!.set!
    await act(async () => {
      setValue.call(name, 'Blank Slate')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Blank Slate',
      instructions: ''
    }))
  })

  it('continues a new agent into full settings before closing the creation flow', async () => {
    const onCreate = vi.fn(async () => undefined)
    const onClose = vi.fn()
    await act(async () => root.render(<BotModal continueToSettings localAgents={[]} onSettings={vi.fn()} onClose={onClose} onCreate={onCreate} onUpdate={vi.fn()} />))
    const name = container.querySelector<HTMLInputElement>('.field-row input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Configured agent')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Configured agent', deferGreeting: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('selects an emoji avatar from a dropdown', async () => {
    const onUpdate = vi.fn(async () => undefined)
    await act(async () => root.render(
      <BotModal
        agent={agents[0]}
        localAgents={[]}
        onSettings={vi.fn()}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />
    ))

    await act(async () => container.querySelector<HTMLButtonElement>('.edit-contact-emoji-trigger')!.click())
    const options = container.querySelectorAll<HTMLButtonElement>('.edit-contact-emoji-grid button')
    expect(options).toHaveLength(48)
    const brain = [...options].find((option) => option.dataset.emoji === '🧠')!
    await act(async () => brain.click())
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())

    expect(onUpdate).toHaveBeenCalledWith('alpha', expect.objectContaining({
      avatar: '',
      avatarEmoji: '🧠'
    }))
  })

  it('offers every detected local agent', async () => {
    const localAgents: LocalAgent[] = [
      { id: 'claude', name: 'Claude Code', command: 'claude', path: '/bin/claude', installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'openclaw', name: 'OpenClaw', command: 'openclaw', path: '/bin/openclaw', installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'fastclaw', name: 'FastClaw', command: 'fastclaw', path: '/bin/fastclaw', installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'hermes', name: 'Hermes', command: 'hermes', path: '/bin/hermes', installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'omp', name: 'OMP', command: 'omp', path: '/bin/omp', installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' },
      { id: 'missing', name: 'Missing', command: 'missing', installed: false, discovered: false, chatSupported: true, status: 'not-found', authentication: 'unchecked' }
    ]
    await act(async () => root.render(
      <BotModal
        localAgents={localAgents}
        onSettings={vi.fn()}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={vi.fn(async () => undefined)}
      />
    ))

    const local = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes('Local agent'))!
    await act(async () => local.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-select-trigger')!.click())

    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent)
    expect(options).toEqual(expect.arrayContaining(['Claude Code', 'OpenClaw', 'FastClaw', 'Hermes', 'OMP']))
    expect(options).not.toContain('Missing')
  })
})

// Component behavior tests use an inline host; NativeDialog has separate window lifecycle tests.
vi.mock('./NativeDialog', async () => {
  const { createElement } = await import('react')
  return { NativeDialog: ({ children, onClose, width, height, ...props }: any) => createElement('div', props, children) }
})
