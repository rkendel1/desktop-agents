// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AgentConfig } from '../../../shared/types'
vi.mock('../preferences', () => ({ t: (s: string) => s, tr: (s: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll('{'+key+'}', String(value)), s) }))
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
import { LocalModelDialog } from './LocalModelDialog'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const agent = { id: 'a', name: 'OpenCode', localAgentId: 'opencode', model: 'default' } as AgentConfig
it('uses model-API selection for a non-CLI agent and saves the chosen provider', async () => {
  const localLoad = vi.fn()
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    listLocalAgentModels: localLoad,
    getCustomModels: vi.fn().mockResolvedValue({ providers: [{ id: 'mine', name: 'My provider', models: ['org/model'], modelLabels: { 'org/model': 'My model' } }], defaultModel: '' })
  } })
  const host = document.createElement('div'); const root = createRoot(host)
  const save = vi.fn().mockResolvedValue(undefined); const close = vi.fn()
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, localAgentId: undefined, provider: 'custom:mine', model: 'org/model' }} onSave={save} onClose={close} />))
    expect(localLoad).not.toHaveBeenCalled()
    expect(host.querySelector('.local-model-search')).toBeNull()
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!
    expect(provider.value).toBe('mine'); expect(model.value).toBe('org/model')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenLastCalledWith('org/model', 'custom:mine', 'default', undefined, undefined)
  } finally { await act(async () => root.unmount()) }
})
it('exposes Ollama as a provider with its own model selector', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: vi.fn().mockResolvedValue({ providers: [
      { id: 'openai', name: 'OpenAI', models: ['gpt'] },
      { id: 'ollama', name: 'Ollama', models: ['qwen3:8b', 'nemotron:latest'] }
    ], defaultModel: 'openai/gpt' })
  } })
  const host = document.createElement('div'); const root = createRoot(host); const save = vi.fn().mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, localAgentId: undefined, provider: 'custom:openai', model: 'gpt' }} onSave={save} onClose={vi.fn()} />))
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!
    expect([...provider.options].map(option => option.textContent)).toContain('Ollama')
    await act(async () => { provider.value = 'ollama'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!
    expect([...model.options].map(option => option.textContent)).toEqual(['qwen3:8b', 'nemotron:latest'])
    model.value = 'nemotron:latest'
    await act(async () => model.dispatchEvent(new Event('change', { bubbles: true })))
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('nemotron:latest', 'custom:ollama', 'default', undefined, undefined)
  } finally { await act(async () => root.unmount()) }
})
it('offers per-agent automatic selection and keeps the default model as its fallback', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: vi.fn().mockResolvedValue({ providers: [{ id: 'mine', name: 'Mine', models: ['org/model'] }], defaultModel: 'mine/org/model' })
  } })
  const host = document.createElement('div'); const root = createRoot(host)
  const save = vi.fn().mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, localAgentId: undefined, provider: 'custom:mine', model: 'org/model' }} onSave={save} onClose={vi.fn()} />))
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!
    expect([...provider.options].map(option => option.textContent)).toContain('Choose the best model for the job')
    await act(async () => { provider.value = '@automatic'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('evaluate each request')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('default', 'custom:@default', 'default', 'best', undefined)
  } finally { await act(async () => root.unmount()) }
})
it('offers lowest-price routing and explains the free-only cost policy', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: vi.fn().mockResolvedValue({ providers: [{ id: 'mine', name: 'Mine', models: ['org/model'] }], defaultModel: 'mine/org/model' })
  } })
  const host = document.createElement('div'); const root = createRoot(host); const save = vi.fn().mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, localAgentId: undefined, provider: 'custom:mine', model: 'org/model' }} onSave={save} onClose={vi.fn()} />))
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!
    await act(async () => { provider.value = '@lowest-cost'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('only permits models classified as free')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('default', 'custom:@default', 'default', 'lowest-cost', undefined)
  } finally { await act(async () => root.unmount()) }
})
it('can change the installed local agent used by an existing agent', async () => {
  const list = vi.fn().mockResolvedValue({ configurable: true, source: 'agent', models: [{ id: 'gpt-new', name: 'New model' }] })
  Object.defineProperty(window, 'douchat', { configurable: true, value: { listLocalAgentModels: list } })
  const host = document.createElement('div'); const root = createRoot(host); const save = vi.fn().mockResolvedValue(undefined)
  const localAgents = [{ id: 'opencode', name: 'OpenCode', installed: true }, { id: 'codex', name: 'Codex', installed: true }] as any
  try {
    await act(async () => root.render(<LocalModelDialog agent={agent} localAgents={localAgents} onSave={save} onClose={vi.fn()} />))
    const localAgent = host.querySelector<HTMLSelectElement>('[aria-label="Local agent"]')!
    await act(async () => { localAgent.value = 'codex'; localAgent.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(list).toHaveBeenLastCalledWith('a', 'codex')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('default', undefined, 'default', undefined, 'codex')
  } finally { await act(async () => root.unmount()) }
})
it('can switch an existing local agent to a configured provider', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    listLocalAgentModels: vi.fn().mockResolvedValue({ configurable: true, source: 'agent', models: [] }),
    getCustomModels: vi.fn().mockResolvedValue({ providers: [{ id: 'mine', name: 'Mine', models: ['org/model'] }], defaultModel: 'mine/org/model' })
  } })
  const host = document.createElement('div'); const root = createRoot(host); const save = vi.fn().mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<LocalModelDialog agent={agent} localAgents={[{ id: 'opencode', name: 'OpenCode', installed: true } as any]} onSave={save} onClose={vi.fn()} />))
    const execution = host.querySelector<HTMLSelectElement>('[aria-label="Execution type"]')!
    await act(async () => { execution.value = 'provider'; execution.dispatchEvent(new Event('change', { bubbles: true })) })
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!
    await act(async () => { provider.value = 'mine'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('org/model', 'custom:mine', 'default', undefined, undefined)
  } finally { await act(async () => root.unmount()) }
})
it('loads models and saves the selected ID, only closing after success', async () => {
  const load = vi.fn().mockResolvedValue({ configurable: true, source: 'agent', models: [{ id: 'provider/test', name: 'Test model' }] })
  Object.defineProperty(window, 'douchat', { configurable: true, value: { listLocalAgentModels: load } })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); const save = vi.fn().mockResolvedValue(undefined); const close = vi.fn()
  try {
    await act(async () => root.render(<LocalModelDialog agent={agent} onSave={save} onClose={close} />))
    expect(load).toHaveBeenCalledWith('a', 'opencode')
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!
    await act(async () => { select.value = 'provider/test'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('provider/test', undefined, 'default', undefined, 'opencode'); expect(close).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); host.remove() }
})
it('keeps the current model when discovery fails and does not close on save failure', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: { listLocalAgentModels: vi.fn().mockRejectedValue(new Error('offline')) } })
  const host = document.createElement('div'); const root = createRoot(host); const close = vi.fn()
  const save = vi.fn().mockRejectedValue(new Error('Save failed'))
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, model: 'provider/existing' }} onSave={save} onClose={close} />))
    expect(host.textContent).toContain('Could not load models')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith('provider/existing', undefined, 'default', undefined, 'opencode'); expect(close).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Save failed')
  } finally { await act(async () => root.unmount()) }
})
it('allows manual model entry and switching back to the local default', async () => {
  Object.defineProperty(window, 'douchat', { configurable: true, value: { listLocalAgentModels: vi.fn().mockResolvedValue({ source: 'manual', models: [], configurable: true }) } })
  const host = document.createElement('div'); const root = createRoot(host)
  const save = vi.fn().mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<LocalModelDialog agent={{ ...agent, model: 'provider/existing' }} onSave={save} onClose={vi.fn()} />))
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!
    expect(select.value).toBe('provider/existing')
    expect(host.querySelector('.local-model-custom')).toBeNull()
    await act(async () => { select.value = '__manual__'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const input = host.querySelector<HTMLInputElement>('.local-model-custom input')!
    expect(input.value).toBe('provider/existing')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'org/manual')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenLastCalledWith('org/manual', undefined, 'default', undefined, 'opencode')
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('.local-model-custom')).toBeNull()
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenLastCalledWith('default', undefined, 'default', undefined, 'opencode')
  } finally { await act(async () => root.unmount()) }
})
