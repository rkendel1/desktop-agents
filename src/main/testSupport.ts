import { mkdtempSync, rmSync } from 'node:fs'
import { onTestFinished } from 'vitest'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DesktopRepository, type DesktopRepositoryOptions } from './desktopRepository'
import type { LocalAgentRegistry } from './localAgents'
import type { BindingRecord, WorkspaceBindings } from './localWorkspaces'

/** A throwaway desktop for tests: real FeltDB in a temporary directory. */
export interface TestDesktop {
  root: string
  repository: DesktopRepository
  /** Close and open the same directory again — what an application restart does. */
  restart(options?: DesktopRepositoryOptions): Promise<DesktopRepository>
  dispose(): Promise<void>
}

const created: TestDesktop[] = []

export async function createTestDesktop(options: DesktopRepositoryOptions = {}, prefix = 'desktop-test-'): Promise<TestDesktop> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const desktop: TestDesktop = {
    root,
    repository: await DesktopRepository.open(root, options),
    async restart(next = {}) {
      await desktop.repository.close()
      desktop.repository = await DesktopRepository.open(root, next)
      return desktop.repository
    },
    async dispose() {
      await desktop.repository.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
  created.push(desktop)
  closeAfterTest(() => desktop.dispose())
  return desktop
}

/** Whatever a test opens is closed when the test ends, so no lock or handle outlives it. */
function closeAfterTest(close: () => Promise<void>): void {
  try { onTestFinished(close) } catch { /* Outside a test: disposeTestDesktops closes it. */ }
}

/** Call from afterEach. */
export async function disposeTestDesktops(): Promise<void> {
  for (const desktop of created.splice(0)) await desktop.dispose()
}

/** Open a repository in the directory that holds `file` (tests still name a state file). */
export async function openAtFile(file: string, options: DesktopRepositoryOptions = {}): Promise<DesktopRepository> {
  const repository = await DesktopRepository.open(dirname(file), options)
  closeAfterTest(() => repository.close().catch(() => undefined))
  return repository
}

/** In-memory stand-in for the FeltDB-backed custom-agent registry, for tests of the registry logic alone. */
export function memoryRegistry(): LocalAgentRegistry {
  let definitions: Awaited<ReturnType<LocalAgentRegistry['localAgentDefinitions']>> = []
  return {
    localAgentDefinitions: async () => structuredClone(definitions),
    replaceLocalAgentDefinitions: async next => { definitions = structuredClone(next) }
  }
}

/** In-memory stand-in for the FeltDB-backed workspace bindings, for tests of the workspace logic alone. */
export function memoryBindings(): WorkspaceBindings & { clear(): void } {
  const records = new Map<string, BindingRecord & { id: string }>()
  return {
    get: async id => records.get(id),
    put: async record => { records.set(record.id, record) },
    all: async () => [...records.values()],
    clear: () => records.clear()
  }
}
