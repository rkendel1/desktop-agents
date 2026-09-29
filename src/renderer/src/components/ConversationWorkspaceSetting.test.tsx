// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AgentConfig, Conversation } from '../../../shared/types'
vi.mock('../preferences', () => ({ t: (s: string) => s }))
import { ConversationWorkspaceSetting } from './ConversationWorkspaceSetting'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents = [{ id: 'codex', localAgentId: 'codex' }] as AgentConfig[]
const conversation = { id: 'direct-codex', type: 'direct', name: 'Codex', agentIds: ['codex'], topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 0, updatedAt: 0 } as Conversation

it('requests the folder picker and clear without an onSnapshot callback, showing only the folder name', async () => {
  const open = vi.fn().mockResolvedValue(undefined)
  const choose = vi.fn().mockResolvedValue({}), clear = vi.fn().mockResolvedValue({})
  Object.defineProperty(window, 'douchat', { configurable: true, value: { openConversationWorkspace: open, chooseConversationWorkspace: choose, clearConversationWorkspace: clear } })
  const host = document.createElement('div'); const root = createRoot(host)
  try {
    await act(async () => root.render(<ConversationWorkspaceSetting conversation={conversation} />))
    await act(async () => host.querySelector<HTMLButtonElement>('.conversation-workspace-actions button')!.click())
    expect(choose).toHaveBeenCalledWith('direct-codex')
    expect(host.querySelector('.conversation-workspace-path span')!.textContent).toBe('Default')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open folder"]')!.click())
    expect(open).toHaveBeenCalledWith('direct-codex')
    await act(async () => root.render(<ConversationWorkspaceSetting conversation={{ ...conversation, workspacePath: '/Users/me/code/project' }} />))
    expect(host.querySelector('.conversation-workspace-path span')!.textContent).toBe('project')
    expect(host.querySelector('.conversation-workspace-path')!.getAttribute('title')).toBe('/Users/me/code/project')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Use default')!.click())
    expect(clear).toHaveBeenCalledWith('direct-codex')
  } finally { await act(async () => root.unmount()) }
})


it('keeps folder authorization out of workspace settings', async () => {
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => root.render(<ConversationWorkspaceSetting conversation={{ ...conversation, allowedFolders: ['/Users/me/assets'] }} />))
    expect(host.textContent).not.toContain('Authorized folders')
    expect(host.textContent).not.toContain('Authorize folder')
    expect(host.textContent).not.toContain('/Users/me/assets')
  } finally { await act(async () => root.unmount()) }
})
