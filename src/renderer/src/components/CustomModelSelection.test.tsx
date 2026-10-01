// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string) => text }))
import { CustomModelSelection } from './CustomModelSelection'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('uses a native select, sorts provider/model names, and preserves the default option', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); const change = vi.fn()
  try {
    await act(async () => root.render(<CustomModelSelection providerId="@default" model="default" onChange={change} config={{ defaultModel: 'z/org/z', providers: [
      { id: 'z', name: 'Zebra', kind: 'openai', apiBase: '', hasKey: true, models: ['org/z'] },
      { id: 'a', name: 'Alpha', kind: 'openai', apiBase: '', hasKey: true, models: ['beta', 'alpha'], modelLabels: { beta: 'Friendly name' } },
      { id: 'jev-local', name: 'Jev', kind: 'jev', apiBase: 'http://127.0.0.1:8765', hasKey: true, models: ['jev-latest'] }
    ] }} />))
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Custom model"]')!
    const labels = () => [...select.options].map(item => item.textContent)
    expect(labels()).toEqual(['Default model', 'a/alpha', 'a/beta', 'z/org/z'])
    expect(host.querySelector('input')).toBeNull()
    await act(async () => {
      select.value = JSON.stringify(['a', 'beta'])
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(change).toHaveBeenCalledWith('a', 'beta')
    expect(host.querySelector('.model-picker-panel')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})
