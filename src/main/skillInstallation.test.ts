import { expect, it, vi } from 'vitest'
import { createSkillInstallationTools, loadSkillSource, searchSkills } from './skillInstallation'
import type { AgentConfig } from '../shared/types'
const content = '---\nname: ppt\ndescription: Make slides\n---\n# Slides\nFollow this workflow.'
const files = [{ path: 'SKILL.md', content }, { path: 'references/layout.md', content: 'Use readable titles' }]
function setup() {
  let actor = { id: 'actor', name: 'Claude', skills: [] } as unknown as AgentConfig
  let target = { id: 'target', name: 'Musk', skills: [] } as unknown as AgentConfig
  const authorize = vi.fn(async (_target: AgentConfig, _details: string, _signal?: AbortSignal) => {})
  const save = vi.fn((a, skills) => { if (a.id === actor.id) actor = { ...a, skills }; else target = { ...a, skills } })
  const tools = createSkillInstallationTools({ current: () => actor, targets: () => [actor, target], authorize, save })
  return { call: (name: string, args: object) => tools.find(t => t.name === name)!.execute('test', args), authorize, save, target: () => target }
}
it('creates for another owned agent only after approval, retaining resources and unrelated skills', async () => {
  const host = setup(); let allow!: () => void
  host.authorize.mockImplementationOnce(() => new Promise(resolve => { allow = resolve }))
  const task = host.call('create_skill', { files, targetAgentId: 'target' })
  await vi.waitFor(() => expect(host.authorize).toHaveBeenCalledOnce())
  expect(host.save).not.toHaveBeenCalled()
  expect(host.authorize.mock.calls[0][1]).toContain('Musk')
  allow(); await task
  expect(host.target().skills![0].files![0].path).toBe('references/layout.md')
  await expect(host.call('create_skill', { files, targetAgentId: 'target' })).rejects.toThrow('already exist')
  const id = host.target().skills![0].id
  await host.call('create_skill', { files, targetAgentId: 'target', replace: true })
  expect(host.target().skills![0].id).toBe(id)
})
it('denial, unknown targets and malformed paths never write configuration', async () => {
  const host = setup()
  host.authorize.mockRejectedValue(new Error('Denied'))
  await expect(host.call('create_skill', { files })).rejects.toThrow('Denied')
  await expect(host.call('create_skill', { files, targetAgentId: 'missing' })).rejects.toThrow('not found')
  await expect(host.call('create_skill', { files: [...files, { path: '../bad', content: '' }] })).rejects.toThrow('path')
  await expect(host.call('install_skill', { source: '/private/nonexistent' })).rejects.toThrow('Denied')
  expect(host.save).not.toHaveBeenCalled()
})
it('rejects concurrent changes during confirmation', async () => {
  const host = setup()
  host.authorize.mockImplementationOnce(async () => { host.target().skills = [{ id: 'other', name: 'Other', content: '', enabled: true }] })
  await expect(host.call('create_skill', { files, targetAgentId: 'target' })).rejects.toThrow('changed during approval')
  expect(host.save).not.toHaveBeenCalled()
})
it('search returns bounded structured registry results', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [{ skillId: 'ppt', source: 'owner/repo', installs: 5 }] }))))
  try { expect((await searchSkills('slides')).skills[0]).toMatchObject({ repo: 'owner/repo', skill: 'ppt' }) }
  finally { vi.unstubAllGlobals() }
})
it('rejects unsupported remote sources without requesting them', async () => {
  await expect(loadSkillSource('http://127.0.0.1/private')).rejects.toThrow('GitHub')
})

it('pins GitHub imports to a commit and preserves package resources', async () => {
  const { zipSync } = await import('fflate')
  const archive = zipSync(Object.fromEntries(files.map(file => [`repo-abc/skills/ppt/${file.path}`, Buffer.from(file.content)])))
  const sha = 'a'.repeat(40)
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sha }))).mockResolvedValueOnce(new Response(archive))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const loaded = await loadSkillSource('owner/repo')
    expect(loaded.source).toBe(`https://github.com/owner/repo/tree/${sha}`)
    expect(fetchMock.mock.calls[1][0]).toBe(`https://codeload.github.com/owner/repo/tar.gz/${sha}`)
    expect(loaded.skills[0].files![0].path).toBe('references/layout.md')
  } finally { vi.unstubAllGlobals() }
})

it('loads a local skill directory with resources and refuses symlink resources', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const folder = await mkdtemp(join(tmpdir(), 'douchat-install-skill-'))
  try {
    await mkdir(join(folder, 'references'))
    for (const file of files) await writeFile(join(folder, file.path), file.content)
    const loaded = await loadSkillSource(folder)
    expect(loaded.skills[0].name).toBe('ppt')
    expect(Buffer.from(loaded.skills[0].files![0].data, 'base64').toString()).toBe('Use readable titles')
    await symlink(join(folder, 'SKILL.md'), join(folder, 'linked.md'))
    await expect(loadSkillSource(folder)).rejects.toThrow('Unsafe')
  } finally { await rm(folder, { recursive: true, force: true }) }
})
