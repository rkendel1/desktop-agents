// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../../../shared/types'
import { AgentSettingsDialog } from './AgentSettingsDialog'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string) => text, usePreferences: () => ({ language: 'en' }), resolveInterfaceLanguage: () => 'en' }))
const agent: AgentConfig = { id: 'alpha', name: 'Alpha', role: 'Assistant', instructions: '', color: '#0b5cff', provider: 'cloud', model: 'default', createdAt: 1 }
let container: HTMLDivElement, root: Root
const update = vi.fn(async () => {}), close = vi.fn()
beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn().mockResolvedValue({ providers: [], defaultModel: '' }), listIMChannels: vi.fn().mockResolvedValue([]) } })
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<AgentSettingsDialog agent={agent} localAgents={[]} onUpdate={update} onClose={close} onDelete={vi.fn()} onModelSettings={vi.fn()} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text && !button.closest('[hidden]'))!
  expect(button).toBeTruthy(); await act(async () => button.click())
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('retains file drafts between tabs, saves both files, and keeps the editor open', async () => {
  await click('Customize')
  expect([...document.querySelectorAll('.agent-file-tabs [role=tab]')].map(tab => tab.textContent)).toEqual(['Soul', 'Identity', 'Bootstrap', 'User profile', 'Memory'])
  await input(document.querySelector('#agent-file-content')!, 'Speak concisely')
  await click('Identity'); await input(document.querySelector('#agent-file-content')!, 'I am a writing assistant')
  await click('Models'); await click('Customize'); await click('Soul')
  expect((document.querySelector('#agent-file-content') as HTMLTextAreaElement).value).toBe('Speak concisely')
  await click('Save')
  expect(update).toHaveBeenCalledWith('alpha', { systemFiles: { 'SOUL.md': 'Speak concisely', 'IDENTITY.md': 'I am a writing assistant' }, expectedSystemFiles: {} })
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Saved')
})
it('keeps drafts after a failed save and asks before closing', async () => {
  await click('Customize'); await input(document.querySelector('#agent-file-content')!, 'Draft')
  update.mockRejectedValueOnce(new Error('Disk is full'))
  await click('Save')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Disk is full')
  await act(async () => document.querySelector<HTMLButtonElement>('.agent-settings-close')!.click())
  expect(window.confirm).toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect((document.querySelector('#agent-file-content') as HTMLTextAreaElement).value).toBe('Draft')
})
it('uploads a skill with a read-only preview and allows disabling it', async () => {
  const open = vi.spyOn(window, 'open')
  await click('Skills')
  expect(document.querySelector('.settings-tabs [aria-current="page"]')?.textContent).toBe('Skills')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Add skill')).toBe(false)
  await click('Upload skills')
  const fileInput = document.querySelector<HTMLInputElement>('.skill-upload-dialog input[type="file"]')!
  const content = '---\nname: Review\ndescription: Review code\n---\nCheck edge cases'
  const parseArchive = vi.fn().mockResolvedValue([
    { id: 'review', name: 'Review', description: 'Review code', content, enabled: true, files: [] },
    { id: 'writer', name: 'Writer', content: 'Write clearly', enabled: true, files: [] }
  ])
  Object.assign(window.douchat, { parseSkillArchive: parseArchive })
  const file = new File(['zip'], 'skills.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer })
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
  await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
  expect(parseArchive).not.toHaveBeenCalled()
  await click('Upload')
  expect(parseArchive).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
  expect(document.querySelector('.skill-upload-dialog')).toBeNull()
  expect(document.querySelectorAll('.agent-skills-list article')).toHaveLength(2)
  expect(document.querySelector('#skill-content')).toBeNull()
  expect(document.querySelector('.agent-skill-badge')?.textContent).toBe('skill')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="View skill Review"]')!.click())
  expect(document.querySelector('#skill-detail-title')?.textContent).toBe('Skill details')
  expect(document.querySelector('.skill-source')?.textContent).toContain('name: Review')
  expect(document.querySelector('.skill-markdown')?.textContent).toContain('Check edge cases')
  expect(document.querySelector('.skill-detail-dialog textarea')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close skill details"]')!.click())
  expect(document.querySelector('.skill-detail-dialog')).toBeNull()
  await act(async () => document.querySelector<HTMLInputElement>('.agent-skill-toggle input')!.click())
  await click('Save')
  expect(update).toHaveBeenCalledWith('alpha', { skills: [expect.objectContaining({ name: 'Review', content, enabled: false }), expect.objectContaining({ name: 'Writer', enabled: true })] })
  await click('Permissions'); await click('Channels'); await click('Profile')
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
  expect(open).not.toHaveBeenCalled()
})

it('allows repeated permission saves inside the same editor', async () => {
  await click('Permissions'); await click('Save')
  await click('Save')
  expect(update).toHaveBeenCalledTimes(2)
  expect(close).not.toHaveBeenCalled()
})

it('retains channel credentials while switching sections', async () => {
  await click('Channels')
  const telegram = [...document.querySelectorAll('.im-card')].find(card => card.textContent?.includes('Telegram'))!
  await act(async () => telegram.querySelector<HTMLButtonElement>('button')!.click())
  await input(document.querySelector('.im-setup input')!, 'draft-token')
  await click('Profile'); await click('Channels')
  expect((document.querySelector('.im-setup input') as HTMLInputElement).value).toBe('draft-token')
})

it('shows only the current agent private profile and memory in read-only tabs', async () => {
  const getUserMemory = vi.fn().mockResolvedValue({ userId: 'owner', agentId: 'alpha', notes: 'My profile', memoryNotes: 'Our agreement', facts: [
    { key: 'preference', kind: 'profile', text: 'Enjoy reading' }, { key: 'progress', kind: 'memory', text: 'Finished chapter one' }
  ] })
  const getGroupMemory = vi.fn()
  Object.assign(window.douchat, { getUserMemory, getGroupMemory })
  await click('Customize')
  await input(document.querySelector('#agent-file-content')!, 'Unsaved soul')
  await click('User profile')
  expect(getUserMemory).toHaveBeenLastCalledWith('alpha')
  let editor = document.querySelector<HTMLTextAreaElement>('#agent-file-content')!
  expect(editor.readOnly).toBe(true)
  expect(editor.value).toBe('My profile\n\nEnjoy reading')
  await click('Memory')
  editor = document.querySelector<HTMLTextAreaElement>('#agent-file-content')!
  expect(editor.value).toBe('Our agreement\n\nFinished chapter one')
  expect(editor.readOnly).toBe(true)
  expect(getGroupMemory).not.toHaveBeenCalled()
  await click('Soul')
  expect(document.querySelector<HTMLTextAreaElement>('#agent-file-content')!.value).toBe('Unsaved soul')
})
