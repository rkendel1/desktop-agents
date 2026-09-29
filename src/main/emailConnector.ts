import { randomUUID } from 'node:crypto'
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { EmailConnectionTestResult, EmailConnectorAccount, EmailConnectorInput } from '../shared/types'
import type { DesktopRepository } from './desktopRepository'
import type { CredentialVault } from './credentialVault'

interface EmailCredential { username: string; password: string }

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(pass(?:word)?|token|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[hidden]')
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[hidden]')
    .slice(0, 300) || 'Connection failed'
}

function validate(input: EmailConnectorInput): EmailConnectorInput {
  const text = (value: unknown, limit = 240): string => typeof value === 'string' ? value.trim().slice(0, limit) : ''
  const port = (value: unknown): number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : 0
  const host = (value: unknown): string => {
    const result = text(value, 253).toLowerCase()
    return /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])$/i.test(result) ? result : ''
  }
  const result: EmailConnectorInput = {
    id: text(input?.id, 80) || undefined,
    name: text(input?.name, 80),
    email: text(input?.email, 254),
    username: text(input?.username, 254),
    password: typeof input?.password === 'string' ? input.password.slice(0, 1024) : undefined,
    imapHost: host(input?.imapHost),
    imapPort: port(input?.imapPort),
    imapSecure: input?.imapSecure !== false,
    smtpHost: host(input?.smtpHost),
    smtpPort: port(input?.smtpPort),
    smtpSecure: input?.smtpSecure !== false,
    agentIds: Array.isArray(input?.agentIds)
      ? [...new Set(input.agentIds.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 120)))]
      : []
  }
  if (!result.name || !/^\S+@\S+\.\S+$/.test(result.email) || !result.username || !result.imapHost || !result.imapPort || !result.smtpHost || !result.smtpPort) {
    throw new Error('Complete the email address, username, and server settings.')
  }
  return result
}

function addresses(values?: MessageAddressObject[]): string[] {
  return (values ?? []).map((value) => value.name && value.address ? `${value.name} <${value.address}>` : value.address || value.name || '').filter(Boolean)
}

function summary(message: FetchMessageObject): Record<string, unknown> {
  return {
    id: String(message.uid),
    subject: message.envelope?.subject || '(no subject)',
    from: addresses(message.envelope?.from),
    to: addresses(message.envelope?.to),
    date: message.envelope?.date || message.internalDate,
    unread: !message.flags?.has('\\Seen'),
    size: message.size
  }
}

export class EmailConnectorManager {
  constructor(private readonly store: DesktopRepository, private readonly vault: CredentialVault) {}

  snapshot(): Promise<EmailConnectorAccount[]> {
    return this.store.connectors()
  }

  private reference(connectorId: string): string {
    return `email:${connectorId}`
  }

  private credential(connectorId: string): EmailCredential | undefined {
    const secret = this.vault.get(this.reference(connectorId))
    if (!secret) return undefined
    try { return JSON.parse(secret) as EmailCredential } catch { return undefined }
  }

  private async resolved(input: EmailConnectorInput): Promise<{ input: EmailConnectorInput; credential: EmailCredential }> {
    const checked = validate(input)
    if (checked.id && !(await this.store.connectors()).some((account) => account.id === checked.id)) {
      throw new Error('Email connection not found')
    }
    const existing = checked.id ? this.credential(checked.id) : undefined
    const credential = { username: checked.username || existing?.username || '', password: checked.password || existing?.password || '' }
    if (!credential.password) throw new Error('Enter the mailbox password or authorization code.')
    return { input: checked, credential }
  }

  private imap(account: Pick<EmailConnectorAccount, 'imapHost' | 'imapPort' | 'imapSecure'>, credential: EmailCredential, verifyOnly = false): ImapFlow {
    return new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: credential.username, pass: credential.password },
      logger: false,
      verifyOnly,
      disableAutoIdle: true,
      connectionTimeout: 12_000,
      greetingTimeout: 8_000,
      socketTimeout: 20_000,
      maxLiteralSize: 2_000_000,
      maxResponseSize: 4_000_000,
      tls: { rejectUnauthorized: true }
    })
  }

  async test(input: EmailConnectorInput): Promise<EmailConnectionTestResult> {
    const resolved = await this.resolved(input)
    const imapResult: EmailConnectionTestResult['imap'] = { ok: false }
    const smtpResult: EmailConnectionTestResult['smtp'] = { ok: false }
    const client = this.imap(resolved.input, resolved.credential, true)
    try { await client.connect(); imapResult.ok = true }
    catch (error) { imapResult.error = publicError(error) }
    finally { client.close() }
    const transport = nodemailer.createTransport({
      host: resolved.input.smtpHost,
      port: resolved.input.smtpPort,
      secure: resolved.input.smtpSecure,
      auth: { user: resolved.credential.username, pass: resolved.credential.password },
      connectionTimeout: 12_000,
      greetingTimeout: 8_000,
      socketTimeout: 20_000,
      tls: { rejectUnauthorized: true }
    })
    try {
      await transport.verify()
      smtpResult.ok = true
    } catch (error) { smtpResult.error = publicError(error) }
    finally { transport.close() }
    return { ok: imapResult.ok && smtpResult.ok, imap: imapResult, smtp: smtpResult }
  }

  async save(raw: EmailConnectorInput): Promise<EmailConnectorAccount> {
    const { input, credential } = await this.resolved(raw)
    const result = await this.test({ ...input, password: credential.password })
    if (!result.ok) throw new Error([result.imap.error, result.smtp.error].filter(Boolean).join(' · ') || 'Email connection failed.')
    if (!this.vault.available) throw new Error('Secure credential storage is unavailable on this computer.')
    const id = input.id || `email-${randomUUID()}`
    const now = Date.now()
    const agents = await this.store.agents()
    const account: EmailConnectorAccount = {
      id,
      kind: 'email',
      name: input.name,
      email: input.email,
      username: input.username,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      agentIds: input.agentIds.filter((agentId) => {
        const agent = agents.find((item) => item.id === agentId)
        return Boolean(agent && !agent.localAgentId)
      }),
      status: 'connected',
      updatedAt: now
    }
    this.vault.set(this.reference(id), JSON.stringify(credential))
    const accounts = (await this.store.connectors()).filter((item) => item.id !== id)
    accounts.push(account)
    await this.store.setConnectors(accounts)
    return account
  }

  async disconnect(accountId: string): Promise<void> {
    await this.account(accountId)
    this.vault.delete(this.reference(accountId))
    await this.store.setConnectors((await this.store.connectors()).filter((item) => item.id !== accountId))
  }

  async createTools(agentId: string): Promise<AgentTool[]> {
    const accounts = (await this.store.connectors()).filter((account) => account.status === 'connected' && account.agentIds.includes(agentId))
    if (!accounts.length) return []
    const allowedAccountIds = new Set(accounts.map((account) => account.id))
    const requireAuthorizedAccount = (accountId: string): void => {
      if (!allowedAccountIds.has(accountId)) throw new Error('This agent is not authorized to use that email account')
    }
    const ids = accounts.map((account) => Type.Literal(account.id))
    const accountId = ids.length === 1 ? ids[0] : Type.Union(ids)
    const listParameters = Type.Object({
      accountId,
      folder: Type.Optional(Type.String({ description: 'Mailbox folder, defaults to INBOX' })),
      query: Type.Optional(Type.String({ description: 'Search text matched against the message headers and body' })),
      unreadOnly: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 }))
    })
    const readParameters = Type.Object({
      accountId,
      messageId: Type.String({ description: 'Message id returned by email_search' }),
      folder: Type.Optional(Type.String({ description: 'Mailbox folder, defaults to INBOX' }))
    })
    const describeAccounts = accounts.map((account) => `${account.id}: ${account.name} <${account.email}>`).join('; ')
    const searchTool: AgentTool<typeof listParameters> = {
      name: 'email_search',
      label: 'Search email',
      description: `List or search messages in an authorized mailbox. Accounts: ${describeAccounts}`,
      parameters: listParameters,
      execute: async (_id, params) => {
        requireAuthorizedAccount(params.accountId)
        const messages = await this.list(params.accountId, params.folder || 'INBOX', params.query, params.unreadOnly, params.limit)
        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }], details: { count: messages.length } }
      }
    }
    const readTool: AgentTool<typeof readParameters> = {
      name: 'email_read',
      label: 'Read email',
      description: 'Read one authorized email message by the id returned from email_search. Attachments are described but not downloaded.',
      parameters: readParameters,
      execute: async (_id, params) => {
        requireAuthorizedAccount(params.accountId)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(await this.read(params.accountId, params.folder || 'INBOX', params.messageId), null, 2) }],
          details: { accountId: params.accountId, messageId: params.messageId }
        }
      }
    }
    return [searchTool, readTool]
  }

  private async account(accountId: string): Promise<EmailConnectorAccount> {
    const account = (await this.store.connectors()).find((item) => item.id === accountId)
    if (!account) throw new Error('Email connection not found')
    return account
  }

  private async withClient<T>(accountId: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const account = await this.account(accountId)
    const credential = this.credential(accountId)
    if (!credential) throw new Error('Email connection needs to be reconnected')
    const client = this.imap(account, credential)
    try { await client.connect(); return await work(client) }
    catch (error) { throw new Error(publicError(error)) }
    finally { try { await client.logout() } catch { client.close() } }
  }

  private async list(accountId: string, folder: string, query?: string, unreadOnly?: boolean, requestedLimit = 20): Promise<Record<string, unknown>[]> {
    return this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder, { readOnly: true })
      const found = await client.search({ ...(query?.trim() ? { text: query.trim().slice(0, 200) } : { all: true }), ...(unreadOnly ? { seen: false } : {}) }, { uid: true })
      const uids = Array.isArray(found) ? found.slice(-Math.min(50, Math.max(1, Math.round(requestedLimit || 20)))).reverse() : []
      if (!uids.length) return []
      const messages = await client.fetchAll(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })
      const byUid = new Map(messages.map((message) => [message.uid, message]))
      return uids.map((uid) => byUid.get(uid)).filter((message): message is FetchMessageObject => Boolean(message)).map(summary)
    })
  }

  private async read(accountId: string, folder: string, messageId: string): Promise<Record<string, unknown>> {
    const uid = Number(messageId)
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('Invalid email message id')
    return this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder, { readOnly: true })
      const message = await client.fetchOne(uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { start: 0, maxLength: 1_000_000 } }, { uid: true })
      if (!message || !message.source) throw new Error('Email message not found')
      const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true })
      const cc = (Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : []).flatMap((entry) => entry.value)
      return {
        ...summary(message),
        cc: cc.map((address) => address.name && address.address ? `${address.name} <${address.address}>` : address.address),
        body: (parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+\n/g, '\n').trim().slice(0, 60_000),
        attachments: parsed.attachments.map((attachment) => ({ filename: attachment.filename, contentType: attachment.contentType, size: attachment.size }))
      }
    })
  }
}
