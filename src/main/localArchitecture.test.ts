import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { FileJsDb } from '@feltdb/core'
import { afterEach, expect, it } from 'vitest'
import { DesktopRepository, DESKTOP_SCHEMA_VERSION } from './desktopRepository'
import { LocalDesktopData } from './desktopData'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'douchat-architecture-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = DesktopRepository.open(root, { seedDemo: true })
  cleanup.push(() => store.close())
  return { store, root }
}

it('serves the renderer through a data boundary that rejects unknown chats and stale memory', async () => {
  const { store } = setup()
  const data = new LocalDesktopData(store)
  const message = store.addMessage({ conversationId: 'crew', topicId: store.activeTopicId('crew'), authorId: 'user', authorName: 'You', text: 'private local text', kind: 'message' })
  expect(await data.searchMessages('crew', 'private local')).toContainEqual(message)
  const document = await data.getUserMemory('dobi')
  await data.saveUserMemory({ ...document, notes: 'My profile' }, 'dobi')
  await expect(data.saveUserMemory({ ...document, notes: 'Stale profile' }, 'dobi')).rejects.toThrow()
  await expect(data.searchMessages('missing', 'private')).rejects.toThrow('Chat not found')
  await expect(data.getMessagePage('crew', 'missing-topic')).rejects.toThrow('Topic not found')
  expect((await new LocalDesktopData(store).getUserMemory('dobi')).notes).toBe('My profile')
})

it('uses full UUIDs for new contacts/groups and rejects stale record edits', () => {
  const { store } = setup()
  const agent = store.createAgent({ name: 'Reader', role: '', instructions: '', color: '#123456', provider: 'local', model: 'default', localAgentId: 'codex' })
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  expect(agent.id).toMatch(uuid)
  const group = store.createGroup({ name: 'Readers', agentIds: [agent.id] })
  expect(group.id).toMatch(uuid)
  const updated = store.updateAgent(agent.id, { name: 'New name', expectedRevision: agent.revision })!
  expect(updated.revision).toBe(agent.revision! + 1)
  expect(updated).not.toHaveProperty('expectedRevision')
  expect(() => store.updateAgent(agent.id, { name: 'Stale', expectedRevision: agent.revision })).toThrow('Agent changed')
  const groupRevision = store.conversation(group.id)!.revision
  store.updateConversation(group.id, { name: 'New group', expectedRevision: groupRevision })
  expect(() => store.updateConversation(group.id, { name: 'Stale', expectedRevision: groupRevision })).toThrow('Conversation changed')
})

it('keeps record revisions across a restart and refuses data written by a newer desktop', () => {
  const { store, root } = setup()
  const before = store.messages
  const revision = store.agent('dobi')!.revision
  store.close()
  const reopened = DesktopRepository.open(root, { seedDemo: true })
  expect(reopened.agent('dobi')?.revision).toBe(revision)
  expect(reopened.messages).toEqual(before)
  reopened.close()
  const felt = new FileJsDb(join(root, 'felt'))
  const desktop = JSON.parse(felt.get('Desktop:local').data!)
  felt.update('Desktop:local', JSON.stringify({ ...desktop, schemaVersion: DESKTOP_SCHEMA_VERSION + 1 }))
  felt.close()
  expect(() => DesktopRepository.open(root)).toThrow('newer version')
  // Failing closed must not leave the directory locked.
  expect(existsSync(join(root, 'felt', 'desktop.lock'))).toBe(false)
})
