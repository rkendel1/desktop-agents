import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { memoryBindings } from './testSupport'
import { configureLocalWorkspaces, localWorkspace, resetLocalWorkspaces, resolveSavedWorkspace, validateWorkspaceFolder } from './localWorkspaces'
import type { AgentConfig } from '../shared/types'
const bindings = memoryBindings()

it('retains files and thread IDs across reloads, isolates identities, and invalidates cleared topics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-workspaces-test-'))
  const config = { id: 'agent/../one', localAgentId: 'codex', model: 'default', name: 'Agent', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(directory, bindings)
    const first = localWorkspace(config, 'direct:chat:topic')!
    writeFileSync(join(first.directory, 'notes.md'), 'Remember the task')
    first.remember('thread-one')
    configureLocalWorkspaces(directory, bindings)
    const restored = localWorkspace(config, 'direct:chat:topic')!
    expect(restored.directory).toBe(first.directory)
    expect(restored.thread).toBe('thread-one')
    expect(readFileSync(join(restored.directory, 'notes.md'), 'utf8')).toBe('Remember the task')
    for (const other of [{ ...config, id: 'other' }]) {
      const workspace = localWorkspace(other, 'direct:chat:topic')!
      expect(workspace.directory).not.toBe(first.directory)
      expect(workspace.thread).toBeUndefined()
    }
    expect(localWorkspace(config, 'direct:chat:other')!.directory).not.toBe(first.directory)
    const changed = localWorkspace({ ...config, model: 'new-model' }, 'direct:chat:topic')!
    expect(changed.directory).toBe(first.directory)
    expect(changed.thread).toBeUndefined()
    changed.remember('new-thread')
    first.remember('stale-thread')
    expect(localWorkspace({ ...config, model: 'new-model' }, 'direct:chat:topic')!.thread).toBe('new-thread')
    resetLocalWorkspaces(key => key === 'direct:chat:topic')
    changed.remember('late-completion')
    const cleared = localWorkspace(config, 'direct:chat:topic')!
    expect(cleared.directory).not.toBe(first.directory)
    expect(cleared.thread).toBeUndefined()
    expect(readFileSync(join(first.directory, 'notes.md'), 'utf8')).toBe('Remember the task')
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})

it('migrates Cursor files to a short path while retaining isolation, reloads and topic resets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-cursor-test-'))
  const config = { id: 'cursor-agent', localAgentId: 'cursor', model: 'default', name: 'Cursor', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(directory, bindings)
    // Simulate the previous layout without mutating real user workspaces.
    const legacy = localWorkspace({ ...config, localAgentId: 'codex' }, 'topic')!
    writeFileSync(join(legacy.directory, 'notes.md'), 'Preserve this file')
    const migrated = localWorkspace(config, 'topic')!
    expect(migrated.directory.length).toBeLessThan(255)
    expect(migrated.directory).not.toBe(legacy.directory)
    expect(readFileSync(join(migrated.directory, 'notes.md'), 'utf8')).toBe('Preserve this file')
    migrated.remember('cursor-thread')
    expect(localWorkspace(config, 'topic')!.thread).toBe('cursor-thread')
    expect(localWorkspace({ ...config, id: 'another' }, 'topic')!.directory).not.toBe(migrated.directory)
    expect(localWorkspace(config, 'other-topic')!.directory).not.toBe(migrated.directory)
    expect(localWorkspace({ ...config, localAgentId: 'codex' }, 'topic')!.directory).toBe(migrated.directory)
    resetLocalWorkspaces(key => key === 'topic')
    const reset = localWorkspace(config, 'topic')!
    expect(reset.directory).not.toBe(migrated.directory)
    expect(reset.thread).toBeUndefined()
    expect(readFileSync(join(migrated.directory, 'notes.md'), 'utf8')).toBe('Preserve this file')
  } finally { configureLocalWorkspaces(); bindings.clear(); rmSync(directory, { recursive: true, force: true }) }
})

it('uses a custom folder in place and never resumes a thread started in another folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-workspaces-custom-'))
  const projectA = join(directory, 'project-a'), projectB = join(directory, 'project-b')
  mkdirSync(projectA); mkdirSync(projectB)
  const config = { id: 'agent', localAgentId: 'codex', model: 'default', name: 'Agent', role: '', instructions: '' } as AgentConfig
  try {
    configureLocalWorkspaces(join(directory, 'user-data'), bindings)
    const managed = localWorkspace(config, 'direct:chat:topic')!
    managed.remember('managed-thread')
    const custom = localWorkspace(config, 'direct:chat:topic', projectA)!
    expect(custom).toMatchObject({ directory: projectA, custom: true, thread: undefined })
    custom.remember('project-a-thread')
    expect(localWorkspace(config, 'direct:chat:topic', projectA)!.thread).toBe('project-a-thread')
    expect(localWorkspace(config, 'direct:chat:topic', projectB)!.thread).toBeUndefined()
    expect(localWorkspace(config, 'direct:chat:topic')!.thread).toBeUndefined()
    resetLocalWorkspaces(() => true)
    expect(localWorkspace(config, 'direct:chat:topic', projectA)!.directory).toBe(projectA)
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
