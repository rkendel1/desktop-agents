import { expect, it } from 'vitest'
import { pack } from 'tar-stream'
import { gzipSync } from 'node:zlib'
import { zipSync, strToU8 } from 'fflate'
import { parseAgentArchive, exportAgentArchive } from './agentArchive'
import type { AgentConfig } from '../shared/types'
const manifest = (name: string) => `---\nname: ${name}\ndescription: Example skill\n---\n# ${name}`
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, typeof data === 'string' ? strToU8(data) : data])))
async function tar(files: Record<string, string>, extra?: { name: string; type: 'symlink'; linkname: string }) {
  const stream = pack()
  const result = (async () => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return gzipSync(Buffer.concat(chunks)) })()
  for (const [name, content] of Object.entries(files)) stream.entry({ name }, content)
  if (extra) stream.entry(extra)
  stream.finalize()
  return result
}
it('imports the third-party agent folder and prefers directories over duplicate nested ZIP skills', async () => {
  const bytes = zip({ 'README.md': 'Readme', 'agent/SOUL.md': 'Persona', 'agent/skills/image-tool/SKILL.md': manifest('image-tool'), 'agent/skills/image-tool/main.py': 'directory version',
    'agent/skills/image-tool.zip': zip({ 'SKILL.md': manifest('image-tool'), 'main.py': 'zip version' }),
    'agent/imgany-skills.zip': zip({ 'rembg/SKILL.md': manifest('rembg'), 'rembg/main.py': 'remove background', 'upscale/SKILL.md': manifest('upscale') }) })
  const result = await parseAgentArchive(bytes)
  expect(result.systemFiles['SOUL.md']).toBe('Persona')
  expect(result.skills.map(skill => skill.name)).toEqual(['image-tool', 'rembg', 'upscale'])
  expect(Buffer.from(result.skills[0].files![0].data, 'base64').toString()).toBe('directory version')
  expect(result.warnings).toContain('duplicate-skills')
})
it('imports Hermes TAR.GZ with a wrapper and ignores credentials, memory and runtime settings', async () => {
  const result = await parseAgentArchive(await tar({ './research/SOUL.md': 'Research', './research/config.yaml': 'model: private-model', './research/.env': 'TOKEN=secret', './research/memories/USER.md': 'private', './research/cron/jobs.json': '{}', './research/skills/search/SKILL.md': manifest('search') }))
  expect(result.sourceRoot).toBe('research/')
  expect(result.systemFiles['SOUL.md']).toBe('Research')
  expect(result.systemFiles).not.toHaveProperty('USER.md')
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(JSON.stringify(result)).not.toContain('private-model')
  expect(result.skills[0].name).toBe('search')
  expect(result.warnings).toContain('ignored-files')
})
it('discovers multiple OpenClaw workspace payloads without merging them', async () => {
  const bytes = await tar({ 'backup/manifest.json': '{}', 'backup/assets/state/openclaw.json': '{}', 'backup/assets/state/workspace-a/SOUL.md': 'A', 'backup/assets/state/workspace-a/skills/a/SKILL.md': manifest('a'), 'backup/assets/workspace-b/AGENTS.md': 'B' })
  const list = await parseAgentArchive(bytes)
  expect(list.candidates).toHaveLength(2)
  expect(list.skills).toEqual([])
  const chosen = await parseAgentArchive(bytes, 'backup/assets/state/workspace-a/')
  expect(chosen.systemFiles['SOUL.md']).toBe('A')
  expect(chosen.systemFiles['AGENTS.md']).toBe('')
  expect(chosen.skills.map(skill => skill.name)).toEqual(['a'])
  await expect(parseAgentArchive(bytes, 'invented/')).rejects.toThrow('selection')
})
it('imports a Hermes distribution and maps system_prompt.md when AGENTS.md is absent', async () => {
  const result = await parseAgentArchive(zip({ 'distribution.yaml': 'name: reviewer', 'system_prompt.md': 'Review carefully', 'config.yaml': 'model: default', 'mcp.json': '{}', 'skills/review/SKILL.md': manifest('review') }))
  expect(result.systemFiles['AGENTS.md']).toBe('Review carefully')
  expect(result.skills[0].name).toBe('review')
})
it('imports wrapped Foundry v2 exports', async () => {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(exportAgentArchive({ name: 'Demo', systemFiles: { 'SOUL.md': 'Soul' }, skills: [] } as unknown as AgentConfig))
  const wrapped = zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [`wrapper/${path}`, content])))
  expect((await parseAgentArchive(wrapped)).systemFiles['SOUL.md']).toBe('Soul')
})
it('rejects TAR traversal, links, duplicate paths, truncation and unreadable packages', async () => {
  await expect(parseAgentArchive(await tar({ '../SOUL.md': 'bad' }))).rejects.toThrow('unsafe')
  await expect(parseAgentArchive(await tar({ 'SOUL.md': 'valid' }, { name: 'linked', type: 'symlink', linkname: '/etc/passwd' }))).rejects.toThrow('regular')
  await expect(parseAgentArchive(await tar({ 'SOUL.md': 'one', './SOUL.md': 'two' }))).rejects.toThrow('duplicate')
  const bytes = await tar({ 'SOUL.md': 'valid' })
  await expect(parseAgentArchive(bytes.subarray(0, bytes.length - 10))).rejects.toThrow()
  await expect(parseAgentArchive(zip({ 'README.md': 'No agent', '.env': 'secret' }))).rejects.toThrow('No supported')
})
it('retains ZIP resources inside a skill rather than treating them as nested skill bundles', async () => {
  const result = await parseAgentArchive(zip({ 'SOUL.md': 'S', 'skills/example/SKILL.md': manifest('example'), 'skills/example/assets/data.zip': zip({ 'data.txt': 'data' }) }))
  expect(result.skills[0].files![0].path).toBe('assets/data.zip')
})
