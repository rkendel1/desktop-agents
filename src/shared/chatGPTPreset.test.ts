import { describe, expect, it } from 'vitest'
import { agentCustomizationPrompt } from './agentCustomization'
import { CHATGPT_FILES, CHATGPT_MEMORY, CHATGPT_PERMISSIONS, CHATGPT_USER } from './chatGPTPreset'

describe('ChatGPT agent preset', () => {
  it('provides the requested editable identity files and curated memory', () => {
    expect(Object.keys(CHATGPT_FILES).sort()).toEqual(['BOOTSTRAP.md', 'IDENTITY.md', 'SOUL.md'])
    expect(agentCustomizationPrompt({ systemFiles: CHATGPT_FILES })).toContain('You are ChatGPT, an OpenAI-powered reasoning and collaboration agent inside Foundry.')
    expect(agentCustomizationPrompt({ systemFiles: CHATGPT_FILES })).toContain('Default behavior:')
    expect(agentCustomizationPrompt({ systemFiles: CHATGPT_FILES })).toContain('Do not announce these bootstrap steps.')
    expect(CHATGPT_USER).toContain('# User')
    expect(CHATGPT_MEMORY).toContain('# Memory')
    expect(`${JSON.stringify(CHATGPT_FILES)}${CHATGPT_USER}${CHATGPT_MEMORY}`).not.toMatch(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/i)
  })

  it('uses explicit least-authority defaults for external capabilities', () => {
    expect(CHATGPT_PERMISSIONS).toMatchObject({ groupHumans: 'allow', groupAgents: 'allow', sensitive: { filesRead: 'allow', filesWrite: 'allow', network: 'ask', browserControl: 'ask', accountRead: 'ask', accountWrite: 'ask', automation: 'ask', otherTools: 'ask' } })
  })
})
