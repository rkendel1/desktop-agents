// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, Conversation } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text
}))

import { AgentAvatar, ConversationAvatar, UserAvatar, conversationMembers, agentSourceLabel, mentionableAgents } from './common'

describe('user avatar', () => {
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

  it('shows the fallback until the remote picture has loaded', async () => {
    await act(async () => root.render(<UserAvatar src="https://example.com/avatar.png" name="Ada" />))

    const avatar = container.querySelector('.user-avatar')!
    const image = container.querySelector<HTMLImageElement>('img')!
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(avatar.classList.contains('has-photo')).toBe(false)
    expect(image.classList.contains('is-loaded')).toBe(false)
    expect(container.querySelector('svg')).not.toBeNull()

    await act(async () => image.dispatchEvent(new Event('load')))

    expect(avatar.classList.contains('has-photo')).toBe(true)
    expect(image.classList.contains('is-loaded')).toBe(true)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('keeps the fallback and removes a picture that fails to load', async () => {
    await act(async () => root.render(<UserAvatar src="https://example.com/missing.png" name="New user" />))

    const image = container.querySelector<HTMLImageElement>('img')!
    await act(async () => image.dispatchEvent(new Event('error')))

    const avatar = container.querySelector('.user-avatar')!
    expect(avatar.classList.contains('has-photo')).toBe(false)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders an emoji avatar instead of the generated fallback', async () => {
    await act(async () => root.render(
      <AgentAvatar agent={{
        id: 'emoji-agent',
        name: 'Emoji agent',
        avatarEmoji: '🧠',
        avatarSeed: 'generated-seed',
        role: 'Assistant',
        instructions: '',
        color: '#7C6CF2',
        provider: 'gateway',
        model: 'default',
        createdAt: 1
      }} />
    ))

    expect(container.querySelector('.emoji-agent-avatar')?.textContent).toBe('🧠')
    expect(container.querySelector('.generated-agent-avatar-art')).toBeNull()
  })

  it('keeps the current user as the last tile in a group avatar', async () => {
    const agents: AgentConfig[] = Array.from({ length: 9 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      role: 'Assistant',
      instructions: '',
      color: '#7C6CF2',
      provider: 'gateway',
      model: 'default',
      createdAt: 1
    }))
    const conversation: Conversation = {
      id: 'group',
      type: 'group',
      name: 'Team',
      agentIds: agents.map((agent) => agent.id),
      topics: [],
      activeTopicId: '',
      unread: 0,
      readAt: 0,
      createdAt: 1,
      updatedAt: 1
    }

    await act(async () => root.render(
      <ConversationAvatar conversation={conversation} agents={agents} userName="Dobi" userAvatar="" />
    ))

    const mosaic = container.querySelector<HTMLElement>('.group-mosaic')!
    expect(mosaic.dataset.count).toBe('9')
    expect(mosaic.children).toHaveLength(9)
    expect(mosaic.lastElementChild?.classList.contains('user-avatar')).toBe(true)
    expect(mosaic.lastElementChild?.getAttribute('aria-label')).toBe('Dobi')
  })

  it('shows a custom group emoji instead of the member mosaic', async () => {
    const conversation: Conversation = { id: 'g', type: 'group', name: '三国英雄', avatarEmoji: '⚔️',
      agentIds: [], topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 0, updatedAt: 0 }
    await act(async () => root.render(<ConversationAvatar conversation={conversation} agents={[]} userName="Human" userAvatar="" />))
    expect(container.querySelector('.emoji-agent-avatar')?.textContent).toBe('⚔️')
    expect(container.querySelector('.group-mosaic')).toBeNull()
  })

  it('uses the same compact source label across contact surfaces', () => {
    const base = {
      name: 'Agent', role: 'Assistant', instructions: '', color: '#7C6CF2', provider: 'anthropic', model: 'default', createdAt: 1
    }
    expect(agentSourceLabel({ ...base, id: 'cloud' })).toBe('Model API')
    expect(agentSourceLabel({ ...base, id: 'custom-model', provider: 'custom:deepseek' })).toBe('Custom model')
    expect(agentSourceLabel({ ...base, id: 'following', provider: 'custom:deepseek', followDefaultModel: true })).toBe('Custom model')
    expect(agentSourceLabel({ ...base, id: 'local', localAgentId: 'opencode', provider: 'local' })).toBe('Local agent · OpenCode')
    expect(agentSourceLabel({ ...base, id: 'custom', localAgentId: 'custom:id', localAgentName: 'Research wrapper', provider: 'local' })).toBe('Local agent · Research wrapper')
  })
})

