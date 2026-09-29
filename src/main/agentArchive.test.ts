import { openAtFile } from './testSupport'
import { expect, it } from 'vitest'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { exportAgentArchive, parseAgentArchive } from './agentArchive'
import type { AgentConfig } from '../shared/types'
import { DesktopRepository } from './desktopRepository'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const agent = {
  id: 'original', color: '#000000', createdAt: 0, name: 'Demo', role: 'Researcher', instructions: 'Helpful', labels: 'Careful', provider: 'private-provider', model: 'private-model',
  systemFiles: { 'SOUL.md': 'Soul', 'TOOLS.md': 'Tools', 'USER.md': 'PRIVATE USER', 'MEMORY.md': 'PRIVATE MEMORY' },
  systemFilesDirectory: '/private/path',
  skills: [{ id: 'old-id', name: 'Skill', enabled: false, content: '# Skill', directory: '/private/skill', files: [{ path: 'references/test.md', data: Buffer.from('中文资料').toString('base64') }, { path: 'assets/binary.bin', data: 'AP8=' }] }]
} as AgentConfig
it('round trips portable files, disabled skills and binary resources without private identifiers or memory', async () => {
  const bytes = exportAgentArchive(agent)
  const files = unzipSync(bytes)
  const manifest = strFromU8(files['agent.json'])
  expect(manifest).toContain('douchat-agent')
  expect(files['SOUL.md']).toBeDefined()
  expect(files['customize/SOUL.md']).toBeUndefined()
  for (const privateValue of ['private-owner', 'private-provider', 'private-model', '/private/', 'PRIVATE USER', 'PRIVATE MEMORY', 'old-id']) expect(manifest).not.toContain(privateValue)
  expect(files['customize/USER.md']).toBeUndefined()
  expect(files['customize/MEMORY.md']).toBeUndefined()
  expect(strFromU8(files['skills/Skill/references/test.md'])).toBe('中文资料')
  const parsed = await parseAgentArchive(bytes)
  expect(parsed.systemFiles['SOUL.md']).toBe('Soul')
  expect(parsed.systemFiles['IDENTITY.md']).toBe('')
  expect(parsed.skills[0]).toMatchObject({ name: 'Skill', enabled: false, content: '# Skill', files: agent.skills![0].files })
  expect(parsed.skills[0].id).not.toBe('old-id')
  expect(parsed.skills[0].directory).toBeUndefined()
})
it('rejects unsupported manifests, missing files, duplicate skill roots and undeclared files', async () => {
  const files = unzipSync(exportAgentArchive(agent))
  const original = JSON.parse(strFromU8(files['agent.json']))
  for (const manifest of [{ ...original, version: 99 }, { ...original, customFiles: ['USER.md'] }, { ...original, skills: [...original.skills, ...original.skills] }, { ...original, skills: [{ ...original.skills[0], directory: '../outside' }] }]) {
    await expect(parseAgentArchive(zipSync({ ...files, 'agent.json': strToU8(JSON.stringify(manifest)) }))).rejects.toThrow()
  }
  await expect(parseAgentArchive(zipSync({ ...files, 'secret.txt': strToU8('secret') }))).rejects.toThrow('undeclared')
  const missing = { ...files }; delete missing['SOUL.md']
  await expect(parseAgentArchive(zipSync(missing))).rejects.toThrow('Missing file')
})
it('replaces custom files and skills while retaining profile, model and memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-import-'))
  const store = await openAtFile(join(directory, 'test.db'), { seedDemo: true })
  try {
    const target = (await store.agents())[0]
    await store.updateAgent(target.id, { systemFiles: { 'SOUL.md': 'Old soul', 'HEARTBEAT.md': 'Old heartbeat', 'USER.md': 'Keep user', 'MEMORY.md': 'Keep memory' }, skills: [] })
    const before = (await store.agent(target.id))!
    const parsed = await parseAgentArchive(exportAgentArchive(agent))
    await store.updateAgent(target.id, { systemFiles: parsed.systemFiles, skills: parsed.skills })
    const after = (await store.agent(target.id))!
    expect(after.name).toBe(before.name)
    expect(after.model).toBe(before.model)
    expect(after.systemFiles).toMatchObject({ 'SOUL.md': 'Soul', 'HEARTBEAT.md': '', 'USER.md': 'Keep user', 'MEMORY.md': 'Keep memory' })
    expect(after.skills).toHaveLength(1)
    expect(after.skills![0].directory).toBeTruthy()
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }) }
})
it('supports an empty package that intentionally clears portable settings', async () => {
  const parsed = await parseAgentArchive(exportAgentArchive({ ...agent, systemFiles: {}, skills: [] }))
  expect(Object.values(parsed.systemFiles).every(value => value === '')).toBe(true)
  expect(parsed.skills).toEqual([])
})

it('uses readable safe skill names and resolves case-insensitive collisions', async () => {
  const names = ['product-growth-diagnostician', 'Skill', 'skill', 'Skill-2', '../bad:name', 'CON', '._hidden', '中文技能']
  const bytes = exportAgentArchive({ ...agent, skills: names.map((name, index) => ({ ...agent.skills![0], id: String(index), name })) })
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['agent.json']))
  expect(manifest.skills.map((skill: { directory: string }) => skill.directory)).toEqual(['skills/product-growth-diagnostician', 'skills/Skill', 'skills/skill-2', 'skills/Skill-2-2', 'skills/..-bad-name', 'skills/skill-CON', 'skills/skill-_hidden', 'skills/中文技能'])
  expect((await parseAgentArchive(bytes)).skills.map(skill => skill.name)).toEqual(names)
})
it('still imports legacy numeric skill directories', async () => {
  const original = unzipSync(exportAgentArchive(agent))
  const manifest = JSON.parse(strFromU8(original['agent.json']))
  manifest.skills[0].directory = 'skills/1'
  manifest.version = 1
  const files = Object.fromEntries(Object.entries(original).map(([path, data]) => [path === 'SOUL.md' || path === 'TOOLS.md' ? `customize/${path}` : path.replace('skills/Skill/', 'skills/1/'), data]))
  files['agent.json'] = strToU8(JSON.stringify(manifest))
  expect((await parseAgentArchive(zipSync(files))).skills[0].name).toBe('Skill')
})
