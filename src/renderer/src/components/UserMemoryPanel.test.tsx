// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UserMemoryPanel } from './UserMemoryPanel'
import { emptyUserMemory } from '../../../shared/userMemory'
vi.mock('../preferences', () => ({ usePreferences: () => ({ language: 'en' }), resolveInterfaceLanguage: () => 'en' }))
let root: Root, container: HTMLDivElement
const get = vi.fn(), save = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  get.mockImplementation(async (agentId?: string) => ({ ...emptyUserMemory('owner', agentId), notes: 'I enjoy reading', facts: [{ key: 'name', text: 'I am Alex', evidence: 'Call me Alex', sourceAgentId: 'agent-one' }] }))
  save.mockImplementation(async value => ({ ...value, revision: value.revision + 1 }))
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getUserMemory: get, saveUserMemory: save } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
async function input(element: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(label: string) { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click()) }
it.each([undefined, 'agent-one'])('edits the selected scope and allows deleting remembered facts (%s)', async agentId => {
  await act(async () => root.render(<UserMemoryPanel agentId={agentId} />))
  expect(get).toHaveBeenCalledWith(agentId)
  expect(container.querySelector('h1')?.textContent).toBe(agentId ? 'User profile & memory' : 'About me')
  await input(container.querySelector('.user-memory-notes textarea')!, 'I enjoy writing')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete memory"]')!.click())
  await click('Save')
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', agentId, notes: 'I enjoy writing', facts: [] }), agentId)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Saved')
})
it('retains the draft when a concurrent conversation changed the memory', async () => {
  await act(async () => root.render(<UserMemoryPanel />))
  await input(container.querySelector('.user-memory-notes textarea')!, 'My draft')
  save.mockRejectedValueOnce(new Error('Memory changed. Reload before saving.'))
  await click('Save')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Memory changed')
  expect((container.querySelector('.user-memory-notes textarea') as HTMLTextAreaElement).value).toBe('My draft')
})

it('manages group memory through its own API and shows speaker attribution', async () => {
  const document = { ...emptyUserMemory('owner'), groupId: 'reading', facts: [{ key: 'hashed-key', memoryKey: 'name', subjectId: 'visitor-id', subjectName: 'Visitor', text: 'I am Alex', evidence: 'Call me Alex' }] }
  const getGroup = vi.fn().mockResolvedValue(document), saveGroup = vi.fn().mockImplementation(async value => ({ ...value, revision: 1 }))
  Object.assign(window.douchat, { getGroupMemory: getGroup, saveGroupMemory: saveGroup })
  await act(async () => root.render(<UserMemoryPanel conversationId="reading" />))
  expect(getGroup).toHaveBeenCalledWith('reading')
  expect(get).not.toHaveBeenCalled()
  expect(container.querySelector('h1')?.textContent).toBe('Group memory')
  expect(container.textContent).toContain('Visitor')
  expect(container.textContent).toContain('visitor-id')
  await input(container.querySelector('.user-memory-notes textarea')!, 'Read together every week')
  await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
  await click('Save')
  expect(saveGroup).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'reading', notes: 'Read together every week', autoRemember: false }), 'reading')
  expect(save).not.toHaveBeenCalled()
})

it('edits long-term summary and moves a fact into the user profile', async () => {
  await act(async () => root.render(<UserMemoryPanel agentId="agent-one" />))
  const notes = container.querySelectorAll<HTMLTextAreaElement>('.user-memory-notes textarea')
  await input(notes[1], 'Long-term project agreement')
  const category = container.querySelector<HTMLSelectElement>('[aria-label="Memory category"]')!
  await act(async () => { category.value = 'profile'; category.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('Save')
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ memoryNotes: 'Long-term project agreement', facts: [expect.objectContaining({ key: 'name', kind: 'profile' })] }), 'agent-one')
})
