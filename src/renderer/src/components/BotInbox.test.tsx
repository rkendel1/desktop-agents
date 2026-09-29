// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../../../shared/types'
vi.mock('../preferences', () => ({
  t: (value: string) => value,
  tr: (value: string, values: Record<string, string>) => Object.entries(values).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, replacement), value)
}))
vi.mock('./common', () => ({
  UserAvatar: ({ name, src }: { name: string; src: string }) => <span data-avatar={name} data-src={src} />,
  ConversationAvatar: () => <span />,
  SidebarResizer: () => null,
  conversationDisplayName: (conversation: { name: string }) => conversation.name,
  formatTime: () => '20:48',
  relativeTime: () => 'Today'
}))
import { BotInbox } from './BotInbox'

it('filters human and agent DMs, local and shared groups, unread chats and search together', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let snapshot = { agents: [], messages: [], conversations: [
    { id: 'human', name: 'Human', type: 'direct', person: { name: 'Human' }, unread: 2 },
    { id: 'agent', name: 'Agent', type: 'direct', unread: 0 },
    { id: 'group', name: 'Local group', type: 'group', unread: 0, manuallyUnread: true, pinned: true },
    { id: 'shared', name: 'Shared group', type: 'group', remoteRoomId: 'shared', unread: 0 },
    { id: 'hidden', name: 'Hidden group', type: 'group', hidden: true, unread: 3 }
  ].map((conversation, index) => ({ ...conversation, agentIds: [], createdAt: index + 1 })) } as unknown as AppSnapshot
  const onMarkAllRead = vi.fn(async () => {
    snapshot = { ...snapshot, conversations: snapshot.conversations.map(conversation => ({ ...conversation, unread: 0, manuallyUnread: false })) }
    render()
  })
  const render = (): void => root.render(<BotInbox snapshot={snapshot} activeId="human" workingIds={new Set()} onSelect={vi.fn()}
    onCreateBot={vi.fn()} onCreateGroup={vi.fn()} onEdit={vi.fn()} onTogglePin={vi.fn()} onDelete={vi.fn()} onUpdate={vi.fn()} onOpenWindow={vi.fn()} onMarkAllRead={onMarkAllRead} />)
  const trigger = (): HTMLButtonElement => host.querySelector('.inbox-filter-trigger')!
  const addButton = (): HTMLButtonElement => host.querySelector('.sidebar-add')!
  const openFilter = async (): Promise<void> => {
    if (!host.querySelector('.inbox-create-menu')) await act(async () => addButton().click())
    await act(async () => trigger().click())
  }
  const visibleNames = (): string[] => [...host.querySelectorAll('.conversation-line strong')].map(node => node.textContent || '')
  const select = async (label: string): Promise<void> => {
    await openFilter()
    const option = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === label)!
    await act(async () => option.click())
    expect(document.activeElement).toBe(addButton())
  }
  try {
    await act(async () => render())
    expect(visibleNames()).toHaveLength(4)
    await select('Direct chats')
    expect(visibleNames().sort()).toEqual(['Agent', 'Human'])
    await select('Group chats')
    expect(visibleNames()).toEqual(['Local group', 'Shared group'])
    const search = host.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'shared')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(visibleNames()).toEqual(['Shared group'])
    await select('Direct chats')
    expect(visibleNames()).toEqual([])
    expect(host.textContent).toContain('No chats match “shared”.')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click())
    await select('Unread')
    expect(visibleNames()).toEqual(['Local group', 'Human'])
    await openFilter()
    expect(host.querySelector('[aria-checked="true"]')?.textContent).toBe('Unread')
    const markRead = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent === 'Mark all as read')!
    await act(async () => markRead.click())
    expect(onMarkAllRead).toHaveBeenCalledOnce()
    expect(visibleNames()).toEqual([])
    expect(host.textContent).toContain('No unread chats')
    await openFilter()
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent === 'Mark all as read')!.disabled).toBe(true)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await select('All chats')
    expect(visibleNames()).toHaveLength(4)
    await openFilter()
    expect(trigger().classList.contains('active')).toBe(false)
    const menu = host.querySelector('.inbox-filter-menu')!
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement?.textContent).toBe('Unread')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.querySelector('.inbox-filter-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(host.querySelector('.inbox-create-menu')).not.toBeNull()
    await openFilter()
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host.querySelector('.inbox-filter-menu')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})
