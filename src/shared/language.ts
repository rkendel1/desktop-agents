export type InterfaceLanguage = 'en' | 'zh-CN'

/** Foundry currently ships English and Simplified Chinese. Chinese system
 * locales, including Traditional variants, receive the complete Chinese UI
 * instead of unexpectedly falling back to English. */
export function supportedInterfaceLanguage(locale: string | null | undefined): InterfaceLanguage {
  return /^zh(?:-|$)/i.test(locale?.trim() || '') ? 'zh-CN' : 'en'
}
