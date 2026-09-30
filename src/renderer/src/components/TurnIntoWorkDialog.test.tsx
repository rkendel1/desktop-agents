// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfig, CodingSession, Project } from '../../../shared/types'

vi.mock('../preferences', () => ({ t: (text: string) => text }))
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

import { TurnIntoWorkDialog } from './TurnIntoWorkDialog'

const project: Project = { id: 'p1', name: 'Desktop', path: '/work/desktop', isGit: true, createdAt: 1, updatedAt: 1 }
const agents = [{ id: 'a1', name: 'Forge' }, { id: 'a2', name: 'Piper' }] as AgentConfig[]
const session = { id: 's1', projectId: 'p1', agentId: 'a2' } as CodingSession
let node: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  window.douchat = { startCodingSession: vi.fn(async () => session) } as unknown as typeof window.douchat
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })

it('lets the user edit the handoff and choose the project, agent, and execution target', async () => {
  const started = vi.fn()
  await act(async () => root.render(<TurnIntoWorkDialog draft={{ title: 'Conversation', task: 'Original context', preferredAgentId: 'a2', workspacePath: project.path }} projects={[project]} agents={agents} onClose={() => {}} onAddProject={async () => project} onStarted={started} />))
  const textarea = node.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Build and test it.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const selects = node.querySelectorAll('select')
  expect((selects[1] as HTMLSelectElement).value).toBe('a2')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(selects[2], 'compute')
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(window.douchat.startCodingSession).toHaveBeenCalledWith({ projectId: 'p1', agentId: 'a2', task: 'Build and test it.', execution: { kind: 'compute' } })
  expect(started).toHaveBeenCalledWith(session)
})

it('asks for a project when none exists', async () => {
  const add = vi.fn(async () => project)
  await act(async () => root.render(<TurnIntoWorkDialog draft={{ title: 'Message', task: 'Do it' }} projects={[]} agents={agents} onClose={() => {}} onAddProject={add} onStarted={() => {}} />))
  await act(async () => node.querySelector<HTMLButtonElement>('.primary-button')!.click())
  expect(add).toHaveBeenCalledOnce()
  expect(window.douchat.startCodingSession).not.toHaveBeenCalled()
})
