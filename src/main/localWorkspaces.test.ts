import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { memoryBindings } from './testSupport'
import { configureLocalWorkspaces, localWorkspace, resetLocalWorkspaces, resolveSavedWorkspace, validateWorkspaceFolder } from './localWorkspaces'
import type { AgentConfig } from '../shared/types'
const bindings = memoryBindings()

it('retains files and thread IDs across reloads, isolates identities, and invalidates cleared topics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-workspaces-test-'))
  const config = { id: 'agent/../one', localAgentId: 'codex', model: 'default', name: 'Agent', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(directory, bindings)
    const first = (await localWorkspace(config, 'direct:chat:topic'))!
    writeFileSync(join(first.directory, 'notes.md'), 'Remember the task')
    await first.remember('thread-one')
    configureLocalWorkspaces(directory, bindings)
    const restored = (await localWorkspace(config, 'direct:chat:topic'))!
    expect(restored.directory).toBe(first.directory)
    expect(restored.thread).toBe('thread-one')
    expect(readFileSync(join(restored.directory, 'notes.md'), 'utf8')).toBe('Remember the task')
    for (const other of [{ ...config, id: 'other' }]) {
      const workspace = (await localWorkspace(other, 'direct:chat:topic'))!
      expect(workspace.directory).not.toBe(first.directory)
      expect(workspace.thread).toBeUndefined()
    }
    expect((await localWorkspace(config, 'direct:chat:other'))!.directory).not.toBe(first.directory)
    const changed = (await localWorkspace({ ...config, model: 'new-model' }, 'direct:chat:topic'))!
    expect(changed.directory).toBe(first.directory)
    expect(changed.thread).toBeUndefined()
    await changed.remember('new-thread')
    await first.remember('stale-thread')
    expect((await localWorkspace({ ...config, model: 'new-model' }, 'direct:chat:topic'))!.thread).toBe('new-thread')
    await resetLocalWorkspaces(key => key === 'direct:chat:topic')
    await changed.remember('late-completion')
    const cleared = (await localWorkspace(config, 'direct:chat:topic'))!
    expect(cleared.directory).not.toBe(first.directory)
    expect(cleared.thread).toBeUndefined()
    expect(readFileSync(join(first.directory, 'notes.md'), 'utf8')).toBe('Remember the task')
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})

it('migrates Cursor files to a short path while retaining isolation, reloads and topic resets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-cursor-test-'))
  const config = { id: 'cursor-agent', localAgentId: 'cursor', model: 'default', name: 'Cursor', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(directory, bindings)
    // Simulate the previous layout without mutating real user workspaces.
    const legacy = (await localWorkspace({ ...config, localAgentId: 'codex' }, 'topic'))!
    writeFileSync(join(legacy.directory, 'notes.md'), 'Preserve this file')
    const migrated = (await localWorkspace(config, 'topic'))!
    expect(migrated.directory.length).toBeLessThan(255)
    expect(migrated.directory).not.toBe(legacy.directory)
    expect(readFileSync(join(migrated.directory, 'notes.md'), 'utf8')).toBe('Preserve this file')
    await migrated.remember('cursor-thread')
    expect((await localWorkspace(config, 'topic'))!.thread).toBe('cursor-thread')
    expect((await localWorkspace({ ...config, id: 'another' }, 'topic'))!.directory).not.toBe(migrated.directory)
    expect((await localWorkspace(config, 'other-topic'))!.directory).not.toBe(migrated.directory)
    expect((await localWorkspace({ ...config, localAgentId: 'codex' }, 'topic'))!.directory).toBe(migrated.directory)
    await resetLocalWorkspaces(key => key === 'topic')
    const reset = (await localWorkspace(config, 'topic'))!
    expect(reset.directory).not.toBe(migrated.directory)
    expect(reset.thread).toBeUndefined()
    expect(readFileSync(join(migrated.directory, 'notes.md'), 'utf8')).toBe('Preserve this file')
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})

it('uses a custom folder in place and never resumes a thread started in another folder', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-workspaces-custom-'))
  const projectA = join(directory, 'project-a'), projectB = join(directory, 'project-b')
  mkdirSync(projectA); mkdirSync(projectB)
  const config = { id: 'agent', localAgentId: 'codex', model: 'default', name: 'Agent', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(join(directory, 'user-data'), bindings)
    const managed = (await localWorkspace(config, 'direct:chat:topic'))!
    await managed.remember('managed-thread')
    const custom = (await localWorkspace(config, 'direct:chat:topic', projectA))!
    expect(custom).toMatchObject({ directory: projectA, custom: true, thread: undefined })
    await custom.remember('project-a-thread')
    expect((await localWorkspace(config, 'direct:chat:topic', projectA))!.thread).toBe('project-a-thread')
    expect((await localWorkspace(config, 'direct:chat:topic', projectB))!.thread).toBeUndefined()
    expect((await localWorkspace(config, 'direct:chat:topic'))!.thread).toBeUndefined()
    await resetLocalWorkspaces(() => true)
    expect((await localWorkspace(config, 'direct:chat:topic', projectA))!.directory).toBe(projectA)
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})

it('rejects unsafe or missing workspace folders', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'douchat-workspaces-validate-')))
  const home = join(directory, 'home'), project = join(home, 'code', 'app'), system = join(directory, 'system'), data = join(directory, 'data')
  for (const path of [project, join(system, 'bin'), data]) mkdirSync(path, { recursive: true })
  writeFileSync(join(directory, 'file.txt'), 'x')
  const options = { home, systemRoots: [system] }
  try {
    configureLocalWorkspaces(data, bindings)
    expect(validateWorkspaceFolder(project, options)).toBe(project)
    expect(validateWorkspaceFolder(join(project, '..', 'app'), options)).toBe(project)
    expect(() => validateWorkspaceFolder('relative/path', options)).toThrow(/absolute/)
    expect(() => validateWorkspaceFolder(join(directory, 'missing'), options)).toThrow(/not found/)
    expect(() => validateWorkspaceFolder(join(directory, 'file.txt'), options)).toThrow(/Not a folder/)
    expect(() => validateWorkspaceFolder('/', options)).toThrow(/root/)
    expect(() => validateWorkspaceFolder(home, options)).toThrow(/home folder/)
    expect(() => validateWorkspaceFolder(join(system, 'bin'), options)).toThrow(/System folders/)
    expect(() => validateWorkspaceFolder(data, options)).toThrow(/data folder/)
    expect(() => validateWorkspaceFolder(directory, options)).toThrow(/data folder/)
    expect(() => resolveSavedWorkspace(join(directory, 'gone'), options)).toThrow(/unavailable/)
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})
