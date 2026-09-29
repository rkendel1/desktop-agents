// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, Conversation } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text,
  tr: (text: string, values: Record<string, unknown>) => text.replace('{count}', String(values.count))
}))

vi.mock('./common', () => ({
  UserAvatar: ({ name }: { name: string }) => <span data-user-avatar={name} />,
  AgentAvatar: ({ agent }: { agent: AgentConfig }) => <span data-agent-avatar={agent.id} />,
  ConversationAvatar: ({ conversation }: { conversation: Conversation }) => (
    <span data-conversation-avatar={conversation.id} />
  ),
  SidebarResizer: () => <span data-sidebar-resizer />,
  agentDisplayName: (agent: AgentConfig) => agent.name,
  agentSourceLabel: (agent: AgentConfig) => agent.localAgentId ? `Local · Codex` : 'Cloud'
}))

import { ContactList } from './ContactList'

const agent: AgentConfig = {
  id: 'alpha', name: 'Alpha', role: 'Assistant', instructions: '', color: '#14B8A6', provider: '', model: '', createdAt: 1
}

const localAgent: AgentConfig = {
  id: 'codex', name: 'Codex', localAgentId: 'codex', role: 'Assistant', instructions: '', color: '#7C6CF2', provider: 'local', model: 'codex', createdAt: 2
}

const group: Conversation = {
  id: 'group-team', savedToContacts: true, type: 'group', name: 'Team room', agentIds: ['alpha'], topics: [], activeTopicId: '', unread: 0,
  readAt: 0, createdAt: 1, updatedAt: 1
}

const snapshot = {
  agents: [agent, localAgent],
  conversations: [group],
  agentStatuses: { alpha: 'idle', codex: 'idle' }
} as unknown as AppSnapshot

describe('contact list', () => {
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

  it('excludes unsaved groups from contacts', async () => {
    await act(async () => root.render(<ContactList snapshot={{ ...snapshot, conversations: snapshot.conversations.map((item) => ({ ...item, savedToContacts: false })) }} onSelect={vi.fn()} />))
    expect([...container.querySelectorAll('.contact-folder')].map((item) => item.textContent)).toContain('Group chats0')
    expect(container.textContent).not.toContain('Team room')
  })

  it('shows contacts without creation or local-agent management shortcuts', async () => {
    await act(async () => root.render(
      <ContactList
        snapshot={snapshot}
        onSelect={vi.fn()}
      />
    ))

    expect(container.querySelector('input[placeholder="Search contacts"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Create contact"]')).toBeNull()
    expect(container.querySelector('.contacts-manage')).toBeNull()
    const folders = [...container.querySelectorAll<HTMLButtonElement>('.contact-folder')]
    expect(folders.map((button) => button.textContent)).toEqual(['Group chats1', 'Agents2'])
    expect([...container.querySelectorAll('.contact-row-copy small')].map((item) => item.textContent)).toEqual([
      'Cloud',
      'Local · Codex'
    ])

    const groups = folders
      .find((button) => button.textContent?.includes('Group chats'))!
    await act(async () => groups.click())

    expect(container.querySelector('[data-conversation-avatar="group-team"]')).not.toBeNull()
    expect(container.textContent).not.toContain('New group')
  })
})
