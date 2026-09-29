import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The OS credential facility, as Electron's `safeStorage` exposes it. */
export interface SecretCodec {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

/**
 * Provider secrets — API keys, mailbox passwords — never enter FeltDB.
 *
 * FeltDB keeps only non-secret configuration and a `credentialRef` naming the
 * secret. The secret itself is encrypted by the operating system's credential
 * store and kept here, so a copy of the desktop's FeltDB directory contains no
 * credentials, and the renderer only ever learns whether one exists.
 */
export class CredentialVault {
  private readonly file: string

  constructor(directory: string, private readonly codec: SecretCodec) {
    this.file = join(directory, 'vault.json')
  }

  private read(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string> }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private write(secrets: Record<string, string>): void {
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(secrets), { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  get available(): boolean { return this.codec.available() }

  has(reference: string): boolean { return reference in this.read() }

  set(reference: string, secret: string): void {
    if (!this.codec.available()) throw new Error('System credential storage is unavailable. Enable the system keychain and try again.')
    this.write({ ...this.read(), [reference]: this.codec.encrypt(secret) })
  }

  get(reference: string): string | undefined {
    const encrypted = this.read()[reference]
    if (!encrypted || !this.codec.available()) return undefined
    try { return this.codec.decrypt(encrypted) } catch { return undefined }
  }

  delete(reference: string): void {
    const secrets = this.read()
    if (!(reference in secrets)) return
    delete secrets[reference]
    this.write(secrets)
  }
}
