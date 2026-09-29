import { expect, it } from 'vitest'
import { groupNotice, groupText, groupTranslations, interpolate, legacyGroupNotice } from './groupText'

it('localizes existing routine notices in either language while preserving the task name', () => {
  const name = '喝水提醒（每5分钟） · {name}'
  for (const [en, zh] of [['Scheduled', '定时'], ['Manual', '手动']]) {
    for (const text of [`${en} routine started · ${name}`, `${zh}任务已开始 · ${name}`]) {
      const notice = legacyGroupNotice({ kind: 'system', authorId: 'system', authorName: 'Foundry', text })!
      expect(groupText('zh-CN', notice.key, notice.values)).toBe(`${zh}任务已开始 · ${name}`)
      expect(groupText('en', notice.key, notice.values)).toBe(`${en} routine started · ${name}`)
      expect(legacyGroupNotice({ kind: 'text', authorId: 'agent', authorName: 'Agent', text })).toBeUndefined()
    }
  }
})

it('can render a persisted notice in a different interface language without changing names', () => {
  const notice = groupNotice('zh-CN', 'Round complete: {count} replied; {absent} unavailable and skipped ({members}).', { count: 3, absent: 1, members: 'エンジニア {count}' })
  expect(notice.text).toBe('本轮已结束：3 人已回复，1 人不可用，已跳过（エンジニア {count}）。')
  expect(groupText('en', notice.localization.key, notice.localization.values)).toBe('Round complete: 3 replied; 1 unavailable and skipped (エンジニア {count}).')
  expect(interpolate('{name} {count}', { name: '{count}', count: 3 })).toBe('{count} 3')
})

it('keeps placeholders consistent across translations', () => {
  for (const [key, value] of Object.entries(groupTranslations)) {
    expect([...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort(), key)
      .toEqual([...key.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort())
  }
})

it('recognizes only owned historical system templates, without mutating persisted text', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    const key = 'Round complete: {count} replied; {absent} unavailable and skipped ({members}).'
    const values = { count: 2, absent: 1, members: 'A (测试) [x] {count}' }
    const message = { kind: 'system', authorId: 'system', authorName: 'Foundry', text: groupText(language, key, values) }
    const before = JSON.stringify(message)
    const notice = legacyGroupNotice(message)!
    expect(groupText('en', notice.key, notice.values)).toBe(groupText('en', key, values))
    expect(groupText('zh-CN', notice.key, notice.values)).toBe(groupText('zh-CN', key, values))
    expect(JSON.stringify(message)).toBe(before)
    expect(legacyGroupNotice({ ...message, kind: 'message', authorId: 'user' })).toBeUndefined()
    expect(legacyGroupNotice({ ...message, authorId: 'agent' })).toBeUndefined()
  }
})
