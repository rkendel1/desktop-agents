import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopRepository } from './desktopRepository'
import { internalMemorySnapshot, isInternalConversation } from './internalMemory'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()))
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'internal-memory-'))
  const store = await openAtFile(join(directory, 'state.db'))
  cleanup.push(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }) })
  const agent = (await store.createAgent({ name: '小丽', role: '', instructions: '', provider: 'test', model: 'test', color: '' }))
  const group = (await store.createGroup({ name: '内部群', agentIds: [agent.id] }))
  return { store, agent, group }
}

it('retrieves private assignments and other internal group memory with provenance', async () => {
  const { store, agent, group } = await fixture()
  await store.userMemories.save({ ...(await store.userMemories.read(agent.id)), memoryNotes: '下周三去杭州两天，待确认会议。' }, agent.id)
  await store.groupMemories.save({ ...(await store.groupMemories.read(group.id)), notes: '内部项目进度' }, group.id)
  const direct = (await store.conversation(`direct-${agent.id}`))!
  await store.addMessage({ conversationId: direct.id, topicId: direct.activeTopicId, kind: 'message', authorId: 'user', authorName: 'Owner', text: '对接人微信 zhongtai' })
  const result = await internalMemorySnapshot(store, '待办')
  expect(result.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: `agent:${agent.id}`, text: expect.stringContaining('下周三去杭州') }),
    expect.objectContaining({ source: `group:${group.id}`, text: '内部项目进度' }),
    expect.objectContaining({ source: `conversation:${direct.id}:${direct.activeTopicId}`, text: expect.stringContaining('zhongtai'), historical: true })
  ]))
  expect(result.truncated).toBe(false)
})

it('treats every local group as internal memory and keeps it out of no other audience', async () => {
  const { store, group } = await fixture()
  await store.groupMemories.save({ ...(await store.groupMemories.read(group.id)), notes: 'INTERNAL_NOTE' }, group.id)
  expect((await isInternalConversation(store, group))).toBe(true)
  expect(JSON.stringify((await internalMemorySnapshot(store)))).toContain('INTERNAL_NOTE')
  expect((await store.groupMemories.read(group.id)).notes).toBe('INTERNAL_NOTE')
})
