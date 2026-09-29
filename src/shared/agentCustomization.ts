import type { AgentConfig } from './types'
import { botIdentityPrompt } from './bot/identity'

export const agentFileNames = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'MEMORY.md', 'AGENTS.md'] as const
export type AgentFileName = typeof agentFileNames[number]
export type AgentFiles = Partial<Record<AgentFileName, string>>
export const MAX_SKILL_BYTES = 64 * 1024 * 1024
export interface AgentSkill { id: string; name: string; content: string; enabled: boolean; description?: string; files?: { path: string; data: string }[]; directory?: string }
export function isSafeSkillPath(path: string): boolean {
  return !!path && path.length <= 1024 && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

export function validateAgentFiles(value: AgentFiles): AgentFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent files')
  const result: AgentFiles = {}
  for (const [name, content] of Object.entries(value)) {
    if (!agentFileNames.includes(name as AgentFileName) || typeof content !== 'string' || content.length > 100_000) throw new Error('Invalid agent file or file exceeds 100,000 characters')
    result[name as AgentFileName] = content
  }
  return result
}

export function validateAgentSkills(value: AgentSkill[]): AgentSkill[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('An agent can have up to 50 skills')
  const ids = new Set<string>()
  let totalBytes = 0
  let fileCount = 0
  return value.map(skill => {
    if (!skill || typeof skill.id !== 'string' || !skill.id || skill.id.length > 100 || ids.has(skill.id)
      || typeof skill.name !== 'string' || !skill.name.trim() || skill.name.length > 100
      || typeof skill.content !== 'string' || skill.content.length > 100_000 || typeof skill.enabled !== 'boolean') throw new Error('Invalid skill or skill exceeds 100,000 characters')
    ids.add(skill.id)
    if (skill.description !== undefined && (typeof skill.description !== 'string' || skill.description.length > 5000)) throw new Error('Invalid skill description')
    if (skill.files !== undefined && !Array.isArray(skill.files)) throw new Error('Invalid skill files')
    const paths = new Set<string>(['skill.md'])
    totalBytes += new TextEncoder().encode(skill.content).length
    const files = skill.files?.map(file => {
      if (++fileCount > 2000 || !file || typeof file.path !== 'string' || !isSafeSkillPath(file.path)
        || paths.has(file.path.toLowerCase()) || typeof file.data !== 'string'
        || file.data.length > MAX_SKILL_BYTES * 4 / 3 + 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid skill resource file')
      paths.add(file.path.toLowerCase())
      totalBytes += file.data.length * 3 / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0)
      return { path: file.path, data: file.data }
    })
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new Error('Conflicting skill file paths')
    }
    if (totalBytes > MAX_SKILL_BYTES) throw new Error('Agent skills exceed 64 MB')
    return { id: skill.id, name: skill.name.trim(), content: skill.content, enabled: skill.enabled,
      ...(skill.description !== undefined ? { description: skill.description } : {}), ...(files ? { files } : {}) }
  })
}

/** Agent-owned instructions apply to both hosted models and local CLI agents. */
export function agentCustomizationPrompt(agent: { systemFiles?: AgentFiles; skills?: AgentSkill[] }): string {
  const files = agentFileNames.filter(name => name !== 'USER.md' && name !== 'MEMORY.md').flatMap(name => agent.systemFiles?.[name]?.trim() ? [`# ${name}\n${agent.systemFiles[name]}`] : [])
  const skills = (agent.skills ?? []).filter(skill => skill.enabled && skill.content.trim()).map(skill => `# Skill: ${skill.name}\nSkill ID: ${skill.id}\n${skill.directory ? `Skill directory: ${skill.directory}\nResolve relative resource and script paths against this directory. Use only available tools and permissions.\n` : ''}${skill.content}`)
  return [...files, ...skills].join('\n\n')
}

export function agentPersona(agent: AgentConfig): { role: string; instructions: string; labels: string } {
  return { role: agent.role, instructions: agent.instructions, labels: agent.labels ?? '' }
}

export function agentIdentityPrompt(agent: AgentConfig): string {
  const persona = agentPersona(agent)
  const hasCustomPersona = ['IDENTITY.md', 'SOUL.md'].some(name => agent.systemFiles?.[name as keyof AgentFiles]?.trim())
  const profile = { name: agent.name, description: [persona.role, persona.instructions].filter(Boolean).join(' — '), labels: persona.labels }
  return [
    hasCustomPersona
      ? [
        'The user-authored IDENTITY.md and SOUL.md below define your current identity, role and personality, including when introducing yourself. IDENTITY.md takes precedence for explicit identity fields; SOUL.md supplies personality and behavior.',
        'Contact profile metadata is only a fallback for fields not defined in those files. It must not override or blend a conflicting name or role into the configured identity. The contact display label in the app does not determine your persona.',
        JSON.stringify(profile)
      ].join('\n')
      : botIdentityPrompt(profile),
    'User-authored personality files below replace built-in personality defaults. Use them for personality and behavior; explicit identity in IDENTITY.md or SOUL.md takes precedence over profile metadata. Do not revive an older identity from conversation history.',
    agentCustomizationPrompt(agent),
    'Douchat runtime: You are a contact built on the Douchat system, which provides the chat workspace and orchestrates model execution and available capabilities. This is background context, not part of your persona or greeting. Do not proactively mention Douchat, your runtime platform, model, or provider in introductions or ordinary replies. A general question such as "who are you?" asks for your configured name and role only. Only when the user explicitly asks which platform you run on or what system you are built on, explain that you run on Douchat. Douchat is your runtime platform, not your model name. User personality settings do not change runtime facts, tools, or permissions.'
  ].filter(Boolean).join('\n\n')
}
