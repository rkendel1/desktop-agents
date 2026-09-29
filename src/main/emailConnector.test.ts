import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialVault } from './credentialVault'
import { createTestDesktop, disposeTestDesktops } from './testSupport'

import type { EmailConnectorAccount } from '../shared/types'
import { EmailConnectorManager } from './emailConnector'

const directories: string[] = []

afterEach(async () => {
  await disposeTestDesktops()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function mailbox(id: string, agentIds: string[] = []): EmailConnectorAccount {
  return {
    id,
    kind: 'email',
    name: 'Work mailbox',
    email: 'work@example.com',
    username: 'work@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    agentIds,
    status: 'connected',
    updatedAt: 1
  }
}

describe('email connector credentials', () => {
  it('keeps the mailbox password in the credential vault, never in FeltDB, and removes it on disconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-email-vault-'))
    directories.push(directory)
    const desktop = await createTestDesktop()
    const vault = new CredentialVault(directory, { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() })
    const manager = new EmailConnectorManager(desktop.repository, vault)
    vi.spyOn(manager, 'test').mockResolvedValue({ ok: true, imap: { ok: true }, smtp: { ok: true } })
    const agent = await desktop.repository.createAgent({ name: 'Mail', role: '', instructions: '', color: '#123456', provider: 'anthropic', model: 'claude-sonnet-4-5' })
    const { agentIds: _agentIds, id: _id, ...input } = mailbox('mail-1', [agent.id])
    const saved = await manager.save({ ...input, agentIds: [agent.id], password: 'private-password' })
    expect(vault.has(`email:${saved.id}`)).toBe(true)
    expect(JSON.stringify((await manager.snapshot()))).not.toContain('private-password')
    const feltDirectory = join(desktop.root, 'felt')
    for (const entry of readdirSync(feltDirectory, { withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(feltDirectory, entry.name), 'utf8')).not.toContain('private-password')
    await manager.disconnect(saved.id)
    expect(vault.has(`email:${saved.id}`)).toBe(false)
    expect((await manager.snapshot())).toEqual([])
  })
})
