import type { DesktopRepository } from './desktopRepository'
import type { CredentialVault } from './credentialVault'
import type { IMChannelStorage, RecordData } from './imChannels'

/**
 * IM channel bindings. The binding, cursor and pending inbox are desktop state
 * and live in FeltDB; the bot token is a credential and lives in the vault.
 */
export class FeltIMChannelStorage implements IMChannelStorage {
  constructor(private repository: DesktopRepository, private vault: CredentialVault) {}

  private reference(id: string): string { return `im:${id}` }

  async load(): Promise<RecordData[]> {
    const stored = (await this.repository.setting<Omit<RecordData, 'token'>[]>('imChannels')) ?? []
    return stored.map(record => {
      const token = this.vault.get(this.reference(record.id))
      if (!token) throw new Error('IM channel credentials are unavailable')
      return { ...record, token }
    })
  }

  async save(records: RecordData[]): Promise<void> {
    const previous = (await this.repository.setting<{ id: string }[]>('imChannels')) ?? []
    for (const record of records) if (this.vault.get(this.reference(record.id)) !== record.token) this.vault.set(this.reference(record.id), record.token)
    await this.repository.setSetting('imChannels', records.map(({ token: _token, ...rest }) => rest))
    for (const old of previous) if (!records.some(record => record.id === old.id)) this.vault.delete(this.reference(old.id))
  }
}
