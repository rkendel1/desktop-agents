import { openAtFile } from './testSupport'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { zipSync, strToU8, type Zippable } from 'fflate'
import { parseSkillArchive } from './skillArchive'
import { DesktopRepository } from './desktopRepository'
import { agentCustomizationPrompt, validateAgentSkills, MAX_SKILL_BYTES } from '../shared/agentCustomization'
const manifest = (name = 'review') => strToU8(`---\nname: ${name}\ndescription: >-\n  Review code\n  carefully\n---\nRead references/guide.md and run scripts/check.sh.`)
const archive = (files: Zippable) => zipSync(files)

it.each(['', 'review/', 'bundle/skills/review/'])('imports a single skill at %s and retains binary and script resources', async prefix => {
  const [skill] = await parseSkillArchive(archive({ [`${prefix}SKILL.md`]: manifest(), [`${prefix}scripts/check.sh`]: strToU8('echo okay'), [`${prefix}assets/icon.bin`]: new Uint8Array([0, 255]), '__MACOSX/._review': strToU8('metadata') }))
  expect(skill).toMatchObject({ name: 'review', description: 'Review code carefully', enabled: true })
  expect(skill.files).toEqual([{ path: 'scripts/check.sh', data: Buffer.from('echo okay').toString('base64') }, { path: 'assets/icon.bin', data: 'AP8=' }])
})
it('imports multiple skills and assigns each resource to its containing skill', async () => {
  const skills = await parseSkillArchive(archive({ 'bundle/a/SKILL.md': manifest('a'), 'bundle/a/references/guide.md': strToU8('a guide'), 'bundle/b/SKILL.md': manifest('b'), 'bundle/b/scripts/run.py': strToU8('print(1)'), 'README.md': strToU8('bundle readme') }))
  expect(skills.map(skill => skill.name)).toEqual(['a', 'b'])
  expect(skills[0].files?.map(file => file.path)).toEqual(['references/guide.md'])
  expect(skills[1].files?.map(file => file.path)).toEqual(['scripts/run.py'])
})
it('does not duplicate nested skills into a parent skill', async () => {
  const skills = await parseSkillArchive(archive({ 'SKILL.md': manifest('root'), 'child/SKILL.md': manifest('child'), 'child/script.py': strToU8('child') }))
  expect(skills[0].files).toEqual([])
  expect(skills[1].files).toHaveLength(1)
})
it.each([
  { 'README.md': strToU8('missing') },
  { 'SKILL.md': strToU8('# no metadata') },
  { 'SKILL.md': strToU8('---\nname: no-description\n---\nbody') },
  { 'SKILL.md': manifest(), '../outside': strToU8('bad') },
  { 'SKILL.md': manifest(), '/outside': strToU8('bad') },
  { 'SKILL.md': manifest(), 'a.txt': strToU8('a'), 'A.txt': strToU8('b') },
  { 'SKILL.md': manifest(), 'link': [strToU8('/etc/passwd'), { os: 3, attrs: 0xa1ff << 16 }] },
  { 'a/SKILL.md': manifest('valid'), 'b/SKILL.md': strToU8('invalid') }
] as Zippable[])('rejects malformed or unsafe archives atomically (%#)', async files => {
  await expect(parseSkillArchive(archive(files))).rejects.toThrow()
})
it('rejects corrupt ZIP and too many skills', async () => {
  await expect(parseSkillArchive(strToU8('not a zip'))).rejects.toThrow()
  await expect(parseSkillArchive(archive(Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`s${index}/SKILL.md`, manifest(`s${index}`)]))))).rejects.toThrow('50')
})
it('rejects oversized declared output before extracting it', async () => {
  const zip = Buffer.from(archive({ 'SKILL.md': manifest() }))
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  zip.writeUInt32LE(MAX_SKILL_BYTES + 1, central + 24)
  await expect(parseSkillArchive(zip)).rejects.toThrow('64 MB')
})
it('saves resources, preserves them across restart, and exposes their directory only for enabled skills', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-skills-'))
  const database = join(directory, 'test.db')
  let store = await openAtFile(database, { seedDemo: true })
  try {
    const skills = await parseSkillArchive(archive({ 'SKILL.md': manifest(), 'references/guide.md': strToU8('saved guide'), 'scripts/check.sh': strToU8('echo okay') }))
    await store.updateAgent('dobi', { skills })
    const saved = (await store.agent('dobi'))!.skills![0]
    expect(readFileSync(join(saved.directory!, 'references/guide.md'), 'utf8')).toBe('saved guide')
    expect(agentCustomizationPrompt((await store.agent('dobi'))!)).toContain(saved.directory)
    await store.close(); store = await openAtFile(database, { seedDemo: true })
    expect(readFileSync(join((await store.agent('dobi'))!.skills![0].directory!, 'scripts/check.sh'), 'utf8')).toBe('echo okay')
    await store.updateAgent('dobi', { skills: [{ ...saved, enabled: false }] })
    expect(agentCustomizationPrompt((await store.agent('dobi'))!)).not.toContain(saved.directory)
    expect((await store.agent('dobi'))!.skills![0].directory).toBe(saved.directory)
    expect(() => validateAgentSkills([{ ...saved, files: [{ path: '../escape', data: 'YQ==' }] }])).toThrow()
    expect(() => validateAgentSkills([{ ...saved, files: [{ path: 'a', data: '' }, { path: 'a/b', data: '' }] }])).toThrow()
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }) }
})
