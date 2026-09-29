// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }) })
import { setPreferences } from '../preferences'
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
  setPreferences({ language: 'zh-CN' })
})
import { DecisionSettings } from './DecisionSettings'
import { type DecisionSettings as Settings } from '../../../shared/groupDecision'

const provider = { id: 'mine', name: 'Mine', kind: 'openai', apiBase: 'https://custom.example/v1', models: ['decider'], hasKey: true }
const defaults: Settings = { mode: 'leader', providerId: '', model: '' }
async function mount(settings = defaults, providers: unknown[] = [provider]) {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const save = vi.fn(async value => value)
  const test = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
  Object.defineProperty(window, 'douchat', { configurable: true, value: {
    getDecisionSettings: vi.fn(async () => settings), getCustomModels: vi.fn(async () => ({ providers, defaultModel: '' })), saveDecisionSettings: save, testDecisionSettings: test
  } })
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<DecisionSettings />))
  return { element, save, test, cleanup: async () => { await act(async () => root.unmount()); element.remove() } }
}
const model: Settings = { mode: 'model', providerId: 'mine', model: 'decider' }

it('offers the default mode, and a decision model only when a provider is configured', async () => {
  const withProvider = await mount()
  try { expect([...withProvider.element.querySelector('select')!.options].map(option => option.text)).toEqual(['默认', '决策模型']) } finally { await withProvider.cleanup() }
  const without = await mount(defaults, [])
  try { expect([...without.element.querySelector('select')!.options].map(option => option.text)).toEqual(['默认']) } finally { await without.cleanup() }
})

it('selects a configured provider and saves it', async () => {
  const { element, save, cleanup } = await mount()
  try {
    const mode = element.querySelector('select')!
    await act(async () => { mode.value = 'model'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(element.querySelectorAll('select')).toHaveLength(3)
    await act(async () => element.querySelector<HTMLButtonElement>('button.primary-button')!.click())
    expect(save).toHaveBeenCalledWith(model)
  } finally { await cleanup() }
})

it('tests the connection once, disables controls while pending, and keeps the mode on success', async () => {
  const { element, test, save, cleanup } = await mount(model)
  try {
    let finish!: (result: { ok: boolean }) => void
    test.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await act(async () => element.querySelector<HTMLButtonElement>('button.secondary-button')!.click())
    expect(element.querySelector('fieldset')!.disabled).toBe(true)
    expect(test).toHaveBeenCalledExactlyOnceWith(model)
    await act(async () => finish({ ok: true }))
    expect(element.querySelector('fieldset')!.disabled).toBe(false)
    expect(element.querySelector('select')!.value).toBe('model')
    expect(save).not.toHaveBeenCalled()
  } finally { await cleanup() }
})

it.each(['Decision service unavailable (HTTP 502).', 'request timed out'])('falls back to default mode and shows the test error: %s', async error => {
  const { element, test, save, cleanup } = await mount({ ...model, healthCheckIntervalSeconds: 120 })
  try {
    if (error === 'request timed out') test.mockRejectedValueOnce(new Error(error))
    else test.mockResolvedValueOnce({ ok: false, error })
    await act(async () => element.querySelector<HTMLButtonElement>('button.secondary-button')!.click())
    expect(element.querySelector('select')!.value).toBe('leader')
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...defaults, healthCheckIntervalSeconds: 120 })
    expect(element.querySelector('[role="alert"]')!.textContent).toContain(error)
    expect(element.querySelector('button.secondary-button')).toBeNull()
  } finally { await cleanup() }
})

it('reports a failed fallback save without claiming the default was persisted', async () => {
  const { element, test, save, cleanup } = await mount(model)
  try {
    test.mockResolvedValueOnce({ ok: false, error: 'offline' })
    save.mockRejectedValueOnce(new Error('disk full'))
    await act(async () => element.querySelector<HTMLButtonElement>('button.secondary-button')!.click())
    expect(element.querySelector('select')!.value).toBe('leader')
    expect(element.textContent).toContain('disk full')
    expect(element.textContent).not.toContain('并保存')
    await act(async () => element.querySelector<HTMLButtonElement>('button.primary-button')!.click())
    expect(save).toHaveBeenLastCalledWith(defaults)
    expect(element.textContent).toContain('群决策设置已保存')
  } finally { await cleanup() }
})

it('updates the scheduling copy and saved confirmation when switching languages', async () => {
  const { element, cleanup } = await mount()
  try {
    await act(async () => element.querySelector<HTMLButtonElement>('button.primary-button')!.click())
    expect(element.textContent).toContain('群决策设置已保存')
    await act(async () => setPreferences({ language: 'en' }))
    expect(element.textContent).not.toMatch(/\p{Script=Han}/u)
    expect(element.querySelector('section')?.getAttribute('aria-label')).toBe('Group decision service')
    expect(element.textContent).toContain('Group decision settings saved. They apply to the next task.')
    await act(async () => setPreferences({ language: 'zh-CN' }))
    expect(element.textContent).toContain('群决策设置已保存')
  } finally { await cleanup() }
})
