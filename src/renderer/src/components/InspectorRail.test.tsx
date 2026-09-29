// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, Conversation, DouchatApi } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text
}))

vi.mock('./common', () => ({
  AgentAvatar: ({ agent }: { agent: AgentConfig }) => <span data-agent-avatar={agent.id} />,
  UserAvatar: ({ name }: { name: string }) => <span data-user-avatar={name} />,
  agentDisplayName: (agent: AgentConfig) => agent.name,
  agentDisplayRole: (agent: AgentConfig) => agent.role
}))

import { InspectorRail } from './InspectorRail'

const agent: AgentConfig = {
  id: 'alpha', name: 'Alpha', role: 'Assistant', instructions: '', color: '#14B8A6', provider: '', model: '', createdAt: 1
}

const group: Conversation = {
  id: 'group-team', type: 'group', name: 'Team room', agentIds: ['alpha'], leadAgentId: 'alpha', topics: [],
  activeTopicId: '', unread: 0, readAt: 0, createdAt: 1, updatedAt: 1
}

const direct: Conversation = {
  id: 'direct-alpha', type: 'direct', name: 'Alpha', agentIds: ['alpha'], topics: [], activeTopicId: '', unread: 0,
  readAt: 0, createdAt: 1, updatedAt: 1
}

const snapshot = {
  agents: [agent], conversations: [group, direct], messages: [], agentStatuses: { alpha: 'idle' },
  routines: [], runs: [],
  userName: 'Dobi', userAvatar: 'data:image/png;base64,avatar'
} as unknown as AppSnapshot

describe('chat details rail', () => {
  let container: HTMLDivElement
  let root: Root
  let updateConversation: ReturnType<typeof vi.fn>
  let setConversationPinned: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    updateConversation = vi.fn(async () => snapshot)
    setConversationPinned = vi.fn(async () => snapshot)
    Object.defineProperty(window, 'douchat', {
      configurable: true,
      value: { updateConversation, setConversationPinned } as unknown as DouchatApi
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderRail(conversation: Conversation = group, onSelectUser = vi.fn(), state: AppSnapshot = snapshot): Promise<void> {
    await act(async () => root.render(
      <InspectorRail
        snapshot={state}
        conversation={conversation}
        members={[agent]}
        onSelectAgent={vi.fn()}
        onSelectUser={onSelectUser}
        onAddMembers={vi.fn()}
        onRemoveMembers={vi.fn()}
      />
    ))
  }

  it.each([direct, group])('requires confirmation to reset $type context without clearing history', async (conversation) => {
    const resetConversationContext = vi.fn(async () => snapshot)
    const clearConversation = vi.fn(async () => snapshot)
    Object.assign(window.douchat, { resetConversationContext, clearConversation })
    await renderRail(conversation)
    const click = async (label: string) => act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click()
    })
    expect([...container.querySelectorAll('.detail-clear')].map(button => button.textContent)).toEqual(['Clear chat history', 'Reset context'])
    await click('Reset context')
    expect(resetConversationContext).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Chat history will be kept')
    await click('Cancel')
    expect(resetConversationContext).not.toHaveBeenCalled()
    await click('Reset context')
    await click('Reset context')
    expect(resetConversationContext).toHaveBeenCalledWith(conversation.id)
    expect(clearConversation).not.toHaveBeenCalled()
    expect(container.querySelector('.detail-clear-confirm')).toBeNull()
  })

  it('marks group-specific unavailable members and removes the marker after recovery', async () => {
    await renderRail(group, vi.fn(), { ...snapshot, groupMemberHealth: { [group.id]: { alpha: { status: 'unavailable', checkedAt: 1 } } } })
    expect(container.querySelector('.member-avatar-wrap .member-unavailable')?.getAttribute('aria-label')).toBe('Temporarily unavailable')
    expect(container.querySelector('.member-unavailable')?.textContent).toBe('')
    await renderRail(group, vi.fn(), { ...snapshot, groupMemberHealth: { [group.id]: { alpha: { status: 'healthy', checkedAt: 2 } } } })
    expect(container.querySelector('.member-unavailable')).toBeNull()
    await renderRail(direct, vi.fn(), { ...snapshot, groupMemberHealth: { [group.id]: { alpha: { status: 'unavailable', checkedAt: 1 } } } })
    expect(container.querySelector('.member-unavailable')).toBeNull()
  })

  it('places the current user after the agents and opens their profile settings', async () => {
    const onSelectUser = vi.fn()
    await renderRail(group, onSelectUser)

    const memberTiles = [...container.querySelectorAll<HTMLButtonElement>('.member-grid > .member-tile:not(.add)')]
    expect(memberTiles).toHaveLength(2)
    expect(memberTiles[0].querySelector('[data-agent-avatar="alpha"]')).not.toBeNull()
    expect(memberTiles[1].querySelector('[data-user-avatar="Dobi"]')).not.toBeNull()

    await act(async () => memberTiles[1].click())
    expect(onSelectUser).toHaveBeenCalledOnce()
  })

  it.each(['Enter', 'blur'])('renames a group inline on %s', async (trigger) => {
    await renderRail()
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit group chat name: Team room"]')!
    expect(edit.querySelector('svg')).not.toBeNull()

    await act(async () => edit.click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Group chat name"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, 'Renamed room')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(trigger === 'blur'
      ? new FocusEvent('focusout', { bubbles: true })
      : new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(updateConversation).toHaveBeenCalledWith(group.id, { name: 'Renamed room' })
  })

  it('offers mute and pin switches for a group chat', async () => {
    await renderRail()
    const mute = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Mute notifications"]')!
    const pin = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pin to top"]')!

    await act(async () => mute.click())
    await act(async () => pin.click())

    expect(updateConversation).toHaveBeenCalledWith(group.id, { muted: true })
    expect(setConversationPinned).toHaveBeenCalledWith(group.id, true)
    expect(container.textContent).not.toContain('Chat settings')
    expect(container.textContent).not.toContain('Agent settings')
  })

  it('keeps mute and pin switches in a direct chat', async () => {
    await renderRail(direct)

    expect(container.querySelector('[role="switch"][aria-label="Mute notifications"]')).not.toBeNull()
    expect(container.querySelector('[role="switch"][aria-label="Pin to top"]')).not.toBeNull()
  })

  it('opens chat history and scheduled tasks in separate dialogs', async () => {
    const runAt = Date.now() + 60_000
    const state = {
      ...snapshot,
      routines: [{
        id: 'routine-1', name: 'Say hello', agentId: agent.id, conversationId: direct.id,
        prompt: 'Send a friendly hello.', target: 'local', schedule: { kind: 'once', runAt },
        timezone: 'Asia/Shanghai', enabled: true, nextRunAt: runAt, createdAt: Date.now(), updatedAt: Date.now()
      }],
      runs: []
    } as AppSnapshot
    await renderRail(direct, vi.fn(), state)

    const options = [...container.querySelectorAll<HTMLButtonElement>('.detail-search-button')]
    expect(options.map((button) => button.textContent?.trim())).toEqual(['Search chat history', 'View scheduled tasks'])

    await act(async () => options[0].click())
    expect(document.querySelector('[aria-labelledby="chat-history-title"]')).not.toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-labelledby="chat-history-title"] button[aria-label="Close"]')!.click())

    await act(async () => options[1].click())
    expect(document.querySelector('[aria-labelledby="routine-records-title"]')?.textContent).toContain('Say hello')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-labelledby="routine-records-title"] button[aria-label="Close"]')!.click())
    expect(document.querySelector('[aria-labelledby="routine-records-title"]')).toBeNull()
  })
})

// Component behavior tests use an inline host; NativeDialog has separate window lifecycle tests.
vi.mock('./NativeDialog', async () => {
  const { createElement } = await import('react')
  return { NativeDialog: ({ children, onClose, width, height, ...props }: any) => createElement('div', props, children) }
})
