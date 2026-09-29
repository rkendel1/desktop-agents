import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { isSafeSkillPath, type AgentSkill } from '../shared/agentCustomization'

/** Read the validated package snapshot, never arbitrary paths on the host. */
export function createSkillTools(currentSkills: () => AgentSkill[] | Promise<AgentSkill[]>): AgentTool[] {
  const find = async (id: string) => {
    const skill = (await currentSkills()).find(item => item.id === id && item.enabled)
    if (!skill) throw new Error('Enabled skill not found for this agent. Call list_skill_files for current IDs.')
    return skill
  }
  const result = (data: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: data })
  const listParameters = Type.Object({
    skillId: Type.Optional(Type.String({ description: 'Omit to list enabled skills; pass an exact skill ID to list its files.' })),
    offset: Type.Optional(Type.Integer({ minimum: 0 }))
  })
  const list: AgentTool<typeof listParameters> = {
    name: 'list_skill_files', label: 'List skill files',
    description: 'List your enabled skills or the packaged files in one skill. Use this to discover references and scripts; does not access personal files.',
    parameters: listParameters,
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted()
      if (!args.skillId) return result({ skills: (await currentSkills()).filter(item => item.enabled).map(({ id, name, description }) => ({ id, name, description })) })
      const skill = await find(args.skillId)
      const paths = ['SKILL.md', ...(skill.files ?? []).map(file => file.path)]
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > paths.length) throw new Error('Invalid file offset')
      return result({ skillId: skill.id, name: skill.name, files: paths.slice(offset, offset + 100), totalFiles: paths.length, nextOffset: offset + 100 < paths.length ? offset + 100 : null })
    }
  }
  const readParameters = Type.Object({
    skillId: Type.String({ description: 'Exact enabled skill ID from the prompt or list_skill_files.' }),
    path: Type.String({ description: 'Exact package-relative path, e.g. references/07-first-value.md.' }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset; use nextOffset to continue reading.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 }))
  })
  const read: AgentTool<typeof readParameters> = {
    name: 'read_skill_file', label: 'Read skill file',
    description: 'Read UTF-8 text from your enabled skill package, including references and script source. Read relevant references before giving a skill-based analysis. Does not execute scripts or access arbitrary local files. Continue with nextOffset until the needed content is read.',
    parameters: readParameters,
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted()
      const skill = await find(args.skillId)
      if (typeof args.path !== 'string' || !isSafeSkillPath(args.path)) throw new Error('Invalid skill file path')
      let content = skill.content
      if (args.path !== 'SKILL.md') {
        const file = skill.files?.find(item => item.path === args.path)
        if (!file) throw new Error('File not found in this skill package')
        const bytes = Buffer.from(file.data, 'base64')
        if (bytes.length > 2_000_000) throw new Error('Skill text file exceeds the 2 MB reading limit')
        if (bytes.includes(0)) throw new Error('Binary skill files cannot be read as text')
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch { throw new Error('Skill file is not valid UTF-8 text') }
      }
      const offset = args.offset ?? 0, limit = args.limit ?? 12000
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new Error('Invalid reading range')
      const end = Math.min(offset + limit, content.length)
      return result({ skillId: skill.id, name: skill.name, path: args.path, offset, content: content.slice(offset, end), totalCharacters: content.length, nextOffset: end < content.length ? end : null })
    }
  }
  return [list, read] as AgentTool[]
}
