import { join } from 'node:path'
import { DesktopRepository } from './desktopRepository'
import { CredentialVault, type SecretCodec } from './credentialVault'
import { CustomModelStore } from './customModels'
import { FeltIMChannelStorage } from './imChannelStorage'
import { configureLocalWorkspaces } from './localWorkspaces'
import { migrateLegacyState, type MigrationReport } from './legacy/migrate'
import { FeltDatabaseError } from './felt/database'
import { configureLocalAgentRegistry } from './localAgents'
import { configureProcessLedger, reapOrphanedProcesses, type ReapReport } from './processLedger'
import { importLocalAgentFile } from './legacy/localAgentRegistry'

/**
 * The local desktop: FeltDB and everything that hangs directly off it.
 *
 * Starting it needs no network, no account and no configured provider. It
 * fails closed — if FeltDB cannot open, `DesktopStartupError` is thrown and
 * nothing else runs; there is no second store to fall back to.
 */
export class DesktopStartupError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'DesktopStartupError'
  }
}

export interface DesktopState {
  repository: DesktopRepository
  vault: CredentialVault
  providers: CustomModelStore
  imStorage: FeltIMChannelStorage
  migration: MigrationReport
  /** Agent processes a previous run left behind, stopped before anything else started. */
  reaped: ReapReport
  /** FeltDB's durable state directory. */
  databaseDirectory: string
}

export interface StartDesktopOptions {
  /** The platform application-data directory (Electron's `userData`). */
  userData: string
  codec: SecretCodec
  demo?: boolean
}

export async function startDesktop(options: StartDesktopOptions): Promise<DesktopState> {
  let repository: DesktopRepository
  try {
    repository = await DesktopRepository.open(options.userData, { seedDemo: options.demo })
  } catch (error) {
    const detail = error instanceof FeltDatabaseError ? error.message : error instanceof Error ? error.message : String(error)
    throw new DesktopStartupError(`The local desktop database could not be opened. ${detail}`, error)
  }
  try {
    // Before any agent can start: whatever the last run left running in a project folder is stopped first.
    const ledger = repository.processLedger()
    const reaped = await reapOrphanedProcesses(ledger)
    configureProcessLedger(ledger)
    const vault = new CredentialVault(join(options.userData, 'credentials'), options.codec)
    const providers = new CustomModelStore(repository, vault)
    const imStorage = new FeltIMChannelStorage(repository, vault)
    configureLocalWorkspaces(options.userData, {
      get: async id => { const binding = await repository.runtimeBinding(id); return binding && { ...binding, owner: 'local', agent: binding.agentId } },
      put: record => repository.putRuntimeBinding({ id: record.id, agentId: record.agent, sessionKey: record.sessionKey, generation: record.generation, fingerprint: record.fingerprint, thread: record.thread, claudeAccountLogin: record.claudeAccountLogin, updatedAt: record.updatedAt ?? Date.now() }),
      all: async () => (await repository.runtimeBindings()).map(binding => ({ ...binding, owner: 'local', agent: binding.agentId }))
    })
    configureLocalAgentRegistry(repository)
    await importLocalAgentFile(repository, join(options.userData, 'local-agents.json'))
    // Migration finishes before anything else can read the repository.
    const migration = await migrateLegacyState(repository, { userData: options.userData, codec: options.codec, vault, imStorage })
    return { repository, vault, providers, imStorage, migration, reaped, databaseDirectory: repository.felt.directory }
  } catch (error) {
    await repository.close()
    throw new DesktopStartupError(`The local desktop could not start. ${error instanceof Error ? error.message : String(error)}`, error)
  }
}

/** Stop cleanly: finish the writes in flight, close FeltDB and release its lock. */
export async function stopDesktop(state: DesktopState | undefined): Promise<void> {
  configureProcessLedger(undefined)
  await state?.repository.close()
}
