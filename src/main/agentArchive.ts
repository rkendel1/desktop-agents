import { parseSkillFiles } from './skillArchive'
import { randomUUID } from 'node:crypto'
import { zipSync } from 'fflate'
import { readAgentArchiveFiles } from './archiveFiles'
import { portableAgentFiles, type AgentArchivePreview } from '../shared/agentArchive'
import { MAX_SKILL_BYTES, isSafeSkillPath, validateAgentFiles, validateAgentSkills, type AgentFiles, type AgentSkill } from '../shared/agentCustomization'
import type { AgentConfig } from '../shared/types'

export function exportAgentArchive(agent: AgentConfig): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  const put = (path: string, value: string) => { entries[path] = Buffer.from(value, 'utf8') }
  const customFiles = portableAgentFiles.filter(name => agent.systemFiles?.[name] !== undefined)
  for (const name of customFiles) put(name, agent.systemFiles![name]!)
  const names = new Set<string>()
  const skills = validateAgentSkills(agent.skills ?? []).map(skill => {
    let base = skill.name.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim()
    if (!base || !isSafeSkillPath(base) || base === '__MACOSX' || base === '.DS_Store' || base.startsWith('._')) base = `skill-${base.replace(/^[. ]+/, '') || 'unnamed'}`
    let name = base
    for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${base}-${suffix}`
    names.add(name.toLowerCase())
    const directory = `skills/${name}`
    put(`${directory}/SKILL.md`, skill.content)
    for (const file of skill.files ?? []) entries[`${directory}/${file.path}`] = Buffer.from(file.data, 'base64')
    return { name: skill.name, description: skill.description, enabled: skill.enabled, directory }
  })
  put('README.md', 'Foundry agent configuration\n\nCustom Markdown files live at the archive root. Skills live in skills/<name>/.\nImport replaces custom files and skills after confirmation. Profile metadata is informational.\nModel credentials, channels, chats and personal memory are not included.\n')
  put('agent.json', JSON.stringify({ format: 'douchat-agent', version: 2,
    profile: { name: agent.name, role: agent.role, instructions: agent.instructions, labels: agent.labels },
    customFiles, skills }, null, 2))
  if (Object.values(entries).reduce((sum, data) => sum + data.length, 0) > MAX_SKILL_BYTES) throw new Error('Agent archive exceeds 64 MB')
  if (Object.keys(entries).length > 2000) throw new Error('Agent archive contains too many files')
  const zip = zipSync(entries, { level: 0 })
  if (zip.length > MAX_SKILL_BYTES) throw new Error('Agent archive exceeds 64 MB')
  return zip
}

function parseDouchatArchive(files: Map<string, Buffer>): AgentArchivePreview {
  const manifest = files.get('agent.json')
  if (!manifest || manifest.length > 1_000_000) throw new Error('Missing or oversized agent.json')
  const text = (path: string) => {
    const bytes = files.get(path)
    if (!bytes) throw new Error(`Missing file: ${path}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  const config = JSON.parse(text('agent.json'))
  if (config.format !== 'douchat-agent' || ![1, 2].includes(config.version)) throw new Error('Unsupported agent archive format or version')
  if (typeof config.profile?.name !== 'string' || !config.profile.name.trim() || config.profile.name.length > 200
    || !Array.isArray(config.customFiles) || !Array.isArray(config.skills) || config.skills.length > 50) throw new Error('Invalid agent archive manifest')
  const used = new Set(['agent.json', 'README.md'])
  const systemFiles: AgentFiles = Object.fromEntries(portableAgentFiles.map(name => [name, '']))
  for (const name of config.customFiles) {
    const path = config.version === 1 ? `customize/${name}` : name
    if (!portableAgentFiles.includes(name) || used.has(path)) throw new Error('Invalid or duplicate custom file')
    used.add(path)
    systemFiles[name as keyof AgentFiles] = text(path)
  }
  const roots = new Set<string>()
  const skills: AgentSkill[] = config.skills.map((skill: { name: string; description?: string; enabled: boolean; directory: string }) => {
    if (!skill || typeof skill.directory !== 'string' || !/^skills\/[^/]+$/.test(skill.directory) || !isSafeSkillPath(skill.directory) || roots.has(skill.directory.toLowerCase())) throw new Error('Invalid or duplicate skill directory')
    roots.add(skill.directory.toLowerCase())
    const prefix = `${skill.directory}/`
    const content = text(`${prefix}SKILL.md`)
    used.add(`${prefix}SKILL.md`)
    const resources = [...files].filter(([path]) => path.startsWith(prefix) && path !== `${prefix}SKILL.md`).map(([path, bytes]) => {
      used.add(path)
      return { path: path.slice(prefix.length), data: bytes.toString('base64') }
    })
    return { id: randomUUID(), name: skill.name, description: skill.description, enabled: skill.enabled, content, files: resources }
  })
  if ([...files.keys()].some(path => !used.has(path))) throw new Error('Archive contains undeclared files')
  return { name: config.profile.name, systemFiles: validateAgentFiles(systemFiles), skills: validateAgentSkills(skills) }
}

const ignoredRootParts = new Set(['skills', 'memories', 'memory', 'sessions', 'logs', '.git', 'node_modules', 'credentials'])
function discoverRoots(files: Map<string, Buffer>): string[] {
  const roots = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/')
    const filename = parts.pop()!
    if (parts.some(part => ignoredRootParts.has(part))) continue
    if (filename === 'agent.json' || filename === 'distribution.yaml' || filename === 'system_prompt.md'
      || portableAgentFiles.includes(filename as typeof portableAgentFiles[number])) {
      if (parts.at(-1) === 'customize') parts.pop()
      roots.add(parts.length ? parts.join('/') + '/' : '')
    }
  }
  // A skills-only profile is valid too; do not treat each SKILL.md as an agent.
  for (const path of files.keys()) {
    const position = path.indexOf('skills/')
    if (position < 0 || position > 0 && path[position - 1] !== '/') continue
    const prefix = path.slice(0, position)
    if (prefix.split('/').some(part => ignoredRootParts.has(part))) continue
    if (path.endsWith('/SKILL.md') || /\.zip$/i.test(path)) roots.add(prefix)
  }
  return [...roots].sort()
}

export async function parseAgentArchive(data: Uint8Array, selectedRoot?: string): Promise<AgentArchivePreview> {
  const archive = await readAgentArchiveFiles(data)
  const roots = discoverRoots(archive)
  if (!roots.length) throw new Error('No supported agent configuration or skills found in archive.')
  if (selectedRoot !== undefined && !roots.includes(selectedRoot)) throw new Error('Agent selection is not in this archive.')
  if (selectedRoot === undefined && roots.length > 1) return { name: '', systemFiles: {}, skills: [], candidates: roots.map(root => ({ root, name: root.replace(/\/$/, '') || '/' })) }
  const root = selectedRoot ?? roots[0]
  // Exclude nested, separately discovered profiles from the selected profile.
  const files = new Map([...archive].filter(([path]) => path.startsWith(root)
    && !roots.some(other => other !== root && other.startsWith(root) && path.startsWith(other)))
    .map(([path, data]) => [path.slice(root.length), data]))
  if (files.has('agent.json')) {
    const parsed = parseDouchatArchive(files)
    return { ...parsed, sourceRoot: root, format: 'Foundry' }
  }
  const systemFiles: AgentFiles = Object.fromEntries(portableAgentFiles.map(name => [name, '']))
  const used = new Set<string>()
  for (const name of portableAgentFiles) {
    const candidates = [name, `customize/${name}`].filter(path => files.has(path))
    if (candidates.length > 1) throw new Error(`Conflicting custom files: ${name}`)
    if (candidates.length) {
      const path = candidates[0]
      systemFiles[name] = new TextDecoder('utf-8', { fatal: true }).decode(files.get(path)!)
      used.add(path)
    }
  }
  if (!systemFiles['AGENTS.md'] && files.has('system_prompt.md')) {
    systemFiles['AGENTS.md'] = new TextDecoder('utf-8', { fatal: true }).decode(files.get('system_prompt.md')!)
    used.add('system_prompt.md')
  }
  const hasCustomFiles = used.size > 0
  const skillFiles = new Map([...files].filter(([path]) => path.startsWith('skills/') && !/^skills\/[^/]+\.zip$/i.test(path)).map(([path, bytes]) => [path.slice(7), bytes]))
  const skills: AgentSkill[] = [...skillFiles.keys()].some(path => path === 'SKILL.md' || path.endsWith('/SKILL.md')) ? parseSkillFiles(skillFiles) : []
  for (const path of files.keys()) if (path.startsWith('skills/') && !/^skills\/[^/]+\.zip$/i.test(path)) used.add(path)
  const seen = new Set(skills.map(skill => skill.name.toLowerCase()))
  if (seen.size !== skills.length) throw new Error('Multiple unpacked skills have the same name. Rename them before importing.')
  const warnings = new Set<string>()
  let expanded = [...archive.values()].reduce((sum, value) => sum + value.length, 0)
  let entries = archive.size
  // Support third-party exports that put one or several skill ZIPs alongside folders.
  // Only one nesting level is supported; directory versions win over ZIP duplicates.
  for (const [path, bytes] of files) {
    if (!/\.zip$/i.test(path) || !(/^skills\/[^/]+\.zip$/i.test(path) || !path.includes('/') && /skill/i.test(path))) continue
    used.add(path)
    const nested = await readAgentArchiveFiles(bytes)
    expanded += [...nested.values()].reduce((sum, value) => sum + value.length, 0)
    entries += nested.size
    if (expanded > MAX_SKILL_BYTES || entries > 2000) throw new Error('Combined archive contents exceed 64 MB or 2,000 files.')
    for (const skill of parseSkillFiles(nested)) {
      if (seen.has(skill.name.toLowerCase())) { warnings.add('duplicate-skills'); continue }
      skills.push(skill); seen.add(skill.name.toLowerCase())
    }
  }
  if ([...files.keys()].some(path => !used.has(path) && path !== 'README.md')) warnings.add('ignored-files')
  if (!hasCustomFiles && !skills.length) throw new Error('This profile has no supported custom files or skills to import.')
  return {
    name: root.split('/').filter(Boolean).at(-1) || 'Agent', sourceRoot: root,
    format: files.has('distribution.yaml') || files.has('config.yaml') ? 'Hermes / Workspace' : 'Workspace',
    warnings: [...warnings], systemFiles: validateAgentFiles(systemFiles), skills: validateAgentSkills(skills)
  }
}
