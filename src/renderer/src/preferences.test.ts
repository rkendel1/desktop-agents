// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

function mockSystemLanguage(language: string): void {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: [language] })
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })))
}

describe('interface language preference', () => {
  beforeEach(() => {
    vi.resetModules()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() }
    })
  })

  it('uses the system language on a fresh install', async () => {
    mockSystemLanguage('zh-CN')
    const { setPreferences, t } = await import('./preferences')

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(t('Settings')).toBe('设置')
    expect(t('Sign in to Douchat')).toBe('登录 Douchat')
    setPreferences({ appearance: 'dark' })
    expect(JSON.parse(localStorage.getItem('douchat.general') || '{}').language).toBe('system')
  })

  it('renders model selection and settings in the selected language', async () => {
    mockSystemLanguage('en')
    const { setPreferences, t, tr } = await import('./preferences')
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { CustomModelSelection } = await import('./components/CustomModelSelection')
    const { CustomModelSettings } = await import('./components/CustomModelSettings')
    const render = () => renderToStaticMarkup(createElement(CustomModelSelection, {
      config: { providers: [], defaultModel: '' }, providerId: 'missing', model: 'my-model', onChange: () => {}
    })) + renderToStaticMarkup(createElement(CustomModelSettings))
    setPreferences({ language: 'en' })
    expect(render()).toContain('Model')
    expect(render()).toContain('Add provider')
    expect(render()).toContain('my-model (unavailable)')
    expect(render()).not.toMatch(/[\u4e00-\u9fff]/)
    setPreferences({ language: 'zh-CN' })
    expect(render()).toContain('模型来源')
    expect(render()).toContain('添加服务商')
    expect(t('Use your own API key. Your model provider handles billing.')).toBe('使用你自己的 API 密钥，费用由模型服务商收取。')
    expect(tr('Edit {name}', { name: 'DeepSeek' })).toBe('编辑 DeepSeek')
  })

  it('stores follow-system as a preference and reacts to a system language change', async () => {
    mockSystemLanguage('zh-CN')
    localStorage.setItem('douchat.general', JSON.stringify({ language: 'system' }))
    const { t } = await import('./preferences')

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(t('Follow system')).toBe('跟随系统')

    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] })
    window.dispatchEvent(new Event('languagechange'))

    expect(document.documentElement.lang).toBe('en')
    expect(t('Settings')).toBe('Settings')
  })

  it('preserves an explicit saved language over the system default', async () => {
    mockSystemLanguage('zh-CN')
    localStorage.setItem('douchat.general', JSON.stringify({ language: 'en' }))
    const { t } = await import('./preferences')

    expect(document.documentElement.lang).toBe('en')
    expect(t('Settings')).toBe('Settings')

    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] })
    window.dispatchEvent(new Event('languagechange'))

    expect(document.documentElement.lang).toBe('en')
    expect(t('Settings')).toBe('Settings')
  })
})
