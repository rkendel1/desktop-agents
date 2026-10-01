// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../preferences', () => ({ usePreferences: () => ({ language: 'zh-CN' }), resolveInterfaceLanguage: (language: string) => language, t: (s: string) => s, tr: (s: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll('{'+key+'}', String(value)), s) }))
import { CustomModelSettings } from './CustomModelSettings'
it('connects and disconnects OpenAI without exposing credentials to the renderer', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const connected = { providers: [{ id: 'openai', name: 'OpenAI', kind: 'openai' as const, apiBase: 'https://api.openai.com/v1', authentication: 'chatgpt-oauth' as const, account: 'person@example.com', models: ['available-model'], hasKey: true }], defaultModel: 'openai/available-model' }
  const connectOpenAI = vi.fn(async () => connected)
  const disconnectOpenAI = vi.fn(async () => ({ providers: [], defaultModel: '' }))
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn(async () => ({ providers: [], defaultModel: '' })), detectOllama: vi.fn(async () => null), connectOpenAI, disconnectOpenAI, cancelOpenAIConnection: vi.fn(async () => {}), cancelTokenDanceAuthorization: vi.fn(async () => {}) } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CustomModelSettings />))
    const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
    await act(async () => button('Continue with ChatGPT').click())
    expect(connectOpenAI).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Account: person@example.com')
    expect(container.textContent).toContain('Authentication: Sign in with ChatGPT')
    expect(JSON.stringify(connected)).not.toMatch(/access-secret|refresh-secret/)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => button('Disconnect').click())
    expect(disconnectOpenAI).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Not connected')
  } finally { vi.restoreAllMocks(); await act(async () => root.unmount()); container.remove() }
})

it('explains identity-only ChatGPT access and offers the OpenAI API-key fallback', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn(async () => ({ providers: [], defaultModel: '' })), detectOllama: vi.fn(async () => null), cancelTokenDanceAuthorization: vi.fn(async () => {}) } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CustomModelSettings />))
    expect(container.textContent).toContain('A basic-profile connection shown in ChatGPT is not a model connection.')
    expect(container.textContent).toContain('Settings → About me')
    const apiKey = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use OpenAI API key')!
    await act(async () => apiKey.click())
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('openai')
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('offers a detected Ollama service with its installed models and no API key', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const config = { providers: [], defaultModel: '' }
  const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama' as const, apiBase: 'http://127.0.0.1:11434', models: ['llama3.2:latest', 'qwen3:8b'] }
  const saveCustomModels = vi.fn(async () => ({ providers: [{ ...ollama, hasKey: true }], defaultModel: 'ollama/llama3.2:latest' }))
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: vi.fn(async () => config), detectOllama: vi.fn(async () => ollama), saveCustomModels,
    cancelTokenDanceAuthorization: vi.fn(async () => {})
  } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CustomModelSettings />))
    expect(container.textContent).toContain('Installed command-line agents are selected under Create agent → Local agent')
    const detected = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use detected Ollama')!
    await act(async () => detected.click())
    expect([...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Model ID"]')].map(input => input.value)).toEqual(ollama.models)
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull()
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Save')!.disabled).toBe(false)
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(saveCustomModels).toHaveBeenCalledWith([expect.objectContaining(ollama)], 'ollama/llama3.2:latest')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('edits a saved provider, tests with the stored key, and saves multiple model IDs', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const config = { providers: [{ id: 'mine', name: 'Mine', kind: 'openai', apiBase: 'https://example.com/v1', models: ['one'], hasKey: true }], defaultModel: 'mine/one' }
  const testCustomModel = vi.fn(async () => ({ ok: true }))
  const saveCustomModels = vi.fn(async () => config)
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn(async () => config), testCustomModel, saveCustomModels } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CustomModelSettings />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit Mine"]')!.click())
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    const add = [...container.querySelectorAll('button')].find(b => b.textContent === 'Add model')!
    async function addModel(value: string) {
      await act(async () => add.click())
      const inputs = container.querySelectorAll<HTMLInputElement>('.custom-model-input-row input[aria-label^="Model ID"]')
      const input = inputs[inputs.length - 1]
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove model 1"]')!.disabled).toBe(true)
    await addModel('org/two')
    await addModel('one')
    await addModel('remove-me')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove model 4"]')!.click())
    await addModel('')
    expect(container.querySelectorAll('.custom-model-input-row')).toHaveLength(4)
    const test = [...container.querySelectorAll('button')].find(b => b.textContent === 'Test connection')!
    await act(async () => test.click())
    expect(testCustomModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'one', provider: expect.objectContaining({ id: 'mine', apiKey: undefined, models: ['one', 'org/two'] }) }))
    expect(container.textContent).toContain('Connection successful')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(saveCustomModels).toHaveBeenCalledWith([expect.objectContaining({ id: 'mine', apiKey: undefined, models: ['one', 'org/two'] })], 'mine/one')
    expect(container.querySelector('form')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('places TokenDance after OpenRouter, defaults to OAuth, saves the authorized key and offers manual key links', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const config = { providers: [], defaultModel: '' }
  const saveCustomModels = vi.fn(async () => config)
  const authorizeTokenDance = vi.fn(async () => 'oauth-fixture-key')
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: vi.fn(async () => config), saveCustomModels, authorizeTokenDance,
    cancelTokenDanceAuthorization: vi.fn(async () => {})
  } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
  const select = async (element: HTMLSelectElement, value: string) => {
    await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  try {
    await act(async () => root.render(<CustomModelSettings />))
    await act(async () => button('Add provider').click())
    expect(container.textContent).toContain('These are local agents, not model providers')
    const preset = container.querySelector<HTMLSelectElement>('.custom-model-fields select')!
    expect([...preset.options].map(o => o.value)).toEqual(['anthropic', 'openai', 'openrouter', 'tokendance', 'deepseek', 'ollama-cloud', 'ollama', 'jev-local', 'custom'])
    for (const id of ['anthropic', 'openai', 'openrouter', 'deepseek']) {
      await select(preset, id)
      expect(container.querySelector('a[target="_blank"]')?.textContent).toContain('Create an API key')
    }
    await select(preset, 'ollama-cloud')
    expect(container.querySelector<HTMLInputElement>('input[value="https://ollama.com/v1"]')).not.toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[aria-label^="Model ID"]')?.value).toBe('gemma4:31b')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://ollama.com/settings/keys')
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull()
    await select(preset, 'tokendance')
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull()
    expect(button('Save').disabled).toBe(true)
    await act(async () => button('Authorize TokenDance').click())
    expect(authorizeTokenDance).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Authorization successful')
    expect(button('Save').disabled).toBe(false)
    await select(container.querySelector('#tokendance-auth-mode')!, 'apikey')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://tokendance.space/keys')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await act(async () => container.querySelector('a')!.click())
    expect(open).toHaveBeenCalledWith('https://tokendance.space/keys', '_blank', 'noopener,noreferrer')
    open.mockRestore()
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('oauth-fixture-key')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(saveCustomModels).toHaveBeenCalledWith([expect.objectContaining({ id: 'tokendance', apiKey: 'oauth-fixture-key', apiBase: 'https://tokendance.space/gateway/v1', models: ['mimo-v2.5'] })], 'tokendance/mimo-v2.5')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('adds a keyless local Jev System One provider without changing the chat default', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const config = { providers: [{ id: 'mine', name: 'Mine', kind: 'openai' as const, apiBase: 'https://example.com/v1', models: ['chat'], hasKey: true }], defaultModel: 'mine/chat' }
  const saveCustomModels = vi.fn(async () => config)
  const testCustomModel = vi.fn(async () => ({ ok: true }))
  Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn(async () => config), detectOllama: vi.fn(async () => null), saveCustomModels, testCustomModel, cancelTokenDanceAuthorization: vi.fn(async () => {}) } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
  try {
    await act(async () => root.render(<CustomModelSettings />))
    await act(async () => button('Add provider').click())
    const preset = container.querySelector<HTMLSelectElement>('.custom-model-fields select')!
    await act(async () => { preset.value = 'jev-local'; preset.dispatchEvent(new Event('change', { bubbles: true })) })
    expect([...container.querySelectorAll<HTMLSelectElement>('select')].some(select => select.value === 'jev')).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input[value="http://127.0.0.1:8765"]')).not.toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[aria-label^="Model ID"]')?.value).toBe('jev-latest')
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(false)
    expect(container.textContent).toContain('typed Noul decision')
    await act(async () => button('Test connection').click())
    expect(testCustomModel).toHaveBeenCalledWith({ provider: expect.objectContaining({ id: 'jev-local', kind: 'jev', apiBase: 'http://127.0.0.1:8765', apiKey: undefined, models: ['jev-latest'] }), model: 'jev-latest' })
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(saveCustomModels).toHaveBeenCalledWith([expect.objectContaining({ id: 'mine' }), expect.objectContaining({ id: 'jev-local', kind: 'jev' })], 'mine/chat')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('discards a late authorization result after switching providers and clears manually entered keys', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  let complete!: (key: string) => void
  const cancel = vi.fn(async () => {})
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getCustomModels: async () => ({ providers: [], defaultModel: '' }),
    authorizeTokenDance: () => new Promise<string>(resolve => { complete = resolve }),
    cancelTokenDanceAuthorization: cancel
  } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<CustomModelSettings />))
    await act(async () => button('Add provider').click())
    const preset = container.querySelector<HTMLSelectElement>('.custom-model-fields select')!
    const choose = async (value: string) => { await act(async () => { preset.value = value; preset.dispatchEvent(new Event('change', { bubbles: true })) }) }
    await choose('tokendance')
    await act(async () => button('Authorize TokenDance').click())
    await choose('openrouter')
    expect(cancel).toHaveBeenCalled()
    await act(async () => complete('late-secret'))
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(key.value).toBe('')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'manual-secret')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await choose('deepseek')
    expect(key.value).toBe('')
    expect(button('Save').disabled).toBe(true)
  } finally { await act(async () => root.unmount()); container.remove() }
})
