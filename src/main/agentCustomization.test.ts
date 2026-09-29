import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DesktopRepository } from './desktopRepository'
import { agentCustomizationPrompt, agentPersona } from '../shared/agentCustomization'
import { DouchatRuntime } from './runtime'
import { runLocalAgent } from './localAgentRuntime'
import type { ComputerProvider } from './computer'

vi.mock('./localAgentRuntime', () => ({ runLocalAgent: vi.fn(), disposeLocalAgentSessions: vi.fn(), resetLocalAgentConversation: vi.fn() }))

it('loads saved customization into hosted and local prompts and picks up later edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-customize-runtime-'))
  const store = await openAtFile(join(directory, 'test.db'))
  const computer: ComputerProvider = { snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn() }
  const runtime = new DouchatRuntime(store, computer, () => {})
  try {
    const agent = (await store.createAgent({ name: 'Writer', role: 'Assistant', instructions: '', color: '#0b5cff', localAgentId: 'codex', provider: 'local', model: 'default' }))
    await store.updateAgent(agent.id, { systemFiles: { 'SOUL.md': 'PERSONALITY_SENTINEL', 'IDENTITY.md': '我是小丽，私人秘书。' }, skills: [{ id: 'review', name: 'Review', content: 'SKILL_SENTINEL', enabled: true }] })
    const internals = runtime as unknown as { systemPrompt: (config: typeof agent, context: 'direct', routineAllowed: boolean) => string }
    const hostedPrompt = internals.systemPrompt((await store.agent(agent.id))!, 'direct', false)
    expect(hostedPrompt).toContain('我是小丽，私人秘书。')
    expect(hostedPrompt).toContain('Contact profile metadata is only a fallback')
    expect(hostedPrompt).not.toContain("Use the profile's name as your display name")
    expect(hostedPrompt).not.toContain('current profile name remains your display name')
    expect(hostedPrompt).toContain('PERSONALITY_SENTINEL'); expect(hostedPrompt).toContain('SKILL_SENTINEL')
    vi.mocked(runLocalAgent).mockResolvedValue({ text: 'Ready', images: [] })
    await runtime.sendMessage(`direct-${agent.id}`, 'Hello')
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('我是小丽，私人秘书。')
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).not.toContain("Use the profile's name as your display name")
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('PERSONALITY_SENTINEL')
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('SKILL_SENTINEL')
    await store.updateAgent(agent.id, { systemFiles: { 'SOUL.md': 'UPDATED_PERSONALITY' }, skills: [] })
    runtime.disposeAgent(agent.id)
    await runtime.sendMessage(`direct-${agent.id}`, 'Hello again')
    const nextPrompt = vi.mocked(runLocalAgent).mock.calls.at(-1)![1]
    expect(nextPrompt).toContain('built on the Foundry system')
    expect(nextPrompt).toContain('\"localRuntime\":\"codex\"')
    expect(nextPrompt).toContain('UPDATED_PERSONALITY'); expect(nextPrompt).not.toContain('SKILL_SENTINEL')
  } finally { for (const agent of (await store.agents())) runtime.disposeAgent(agent.id); await store.close(); rmSync(directory, { recursive: true, force: true }); vi.clearAllMocks() }
})

it('persists agent-specific files and skills, merges file edits, and rejects malformed updates atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-customize-'))
  const path = join(directory, 'test.db')
  let store = await openAtFile(path, { seedDemo: true })
  try {
    await store.updateAgent('dobi', { systemFiles: { 'SOUL.md': 'Be concise' }, skills: [
      { id: 'review', name: 'Review', content: 'Check edge cases', enabled: true },
      { id: 'off', name: 'Off', content: 'DO_NOT_INCLUDE', enabled: false }
    ] })
    await store.updateAgent('dobi', { systemFiles: { 'SOUL.md': 'Be clear' } })
    await expect(async () => (await store.updateAgent('dobi', { systemFiles: { 'USER.md': 'Wrong' }, skills: [{ id: 'bad', name: '', content: '', enabled: true }] }))).rejects.toThrow()
    await store.close(); store = await openAtFile(path, { seedDemo: true })
    const agent = (await store.agent('dobi'))!
    expect(agent.systemFiles).toEqual({ 'SOUL.md': 'Be clear' })
    const prompt = agentCustomizationPrompt(agent)
    expect(prompt).toContain('# SOUL.md\nBe clear'); expect(prompt).not.toContain('# USER.md')
    expect(prompt).toContain('Check edge cases'); expect(prompt).not.toContain('DO_NOT_INCLUDE')
    expect(agentCustomizationPrompt((await store.agent('lin'))!)).toBe('')
    await store.updateAgent('dobi', { systemFiles: { 'SOUL.md': '' }, skills: [] })
    expect(agentCustomizationPrompt((await store.agent('dobi'))!)).toBe('')
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }) }
})
