import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeltDB, parseFlowSpec } from '@feltdb/core'
import { desktopFlow } from '../felt/database'
import { CodingApi } from '../coding/api'
import { TestKit, taskText, type Booted } from '../coding/testkit'
import { connectGitHub, openDesktopGitHub, parseGitHubRemote, projectRemote } from './github'
import { ensureClientApiKey, openDesktopServices } from './services'
import { createFoundryAppPort } from './host'
import { apiKeyAuthenticator } from './services'
import { createClient } from '@appport/client'
import { createInProcessTransport } from '@appport/transport-inprocess'

const kit = new TestKit()
afterEach(async () => { vi.unstubAllGlobals(); await kit.cleanup() })

/** Every collection FeltDB actually holds rows for, read from the flow directory itself. */
function physicalCollections(directory: string): Set<string> {
  const names = new Set<string>()
  for (const file of readdirSync(directory).filter(name => name.endsWith('.journal') || name === 'state.json')) {
    const text = readFileSync(join(directory, file), 'utf8')
    for (const match of text.matchAll(/"collection":"([^"]+)"/g)) names.add(match[1])
  }
  return names
}
const flowFiles = (directory: string): string[] => readdirSync(directory).sort()
const allText = (directory: string): string => readdirSync(directory).filter(name => !name.endsWith('.lock')).map(name => { try { return readFileSync(join(directory, name), 'utf8') } catch { return '' } }).join('\n')

async function world() {
  const booted = await kit.boot()
  const directory = booted.desktop.databaseDirectory
  const services = openDesktopServices(directory)
  const github = openDesktopGitHub(directory, booted.desktop.vault)
  return { booted, directory, services, github }
}

describe('one flow for Foundry, AppPort Services and @appport/github', () => {
  it('resolves all three to the same flow directory, and each one’s state lands in it', async () => {
    const { booted, directory, services, github } = await world()
    const path = kit.repository()
    const project = await booted.coding.addProject(path, 'Shared')
    await ensureClientApiKey(services, booted.root)
    await connectGitHub(github, booted.desktop.vault)

    // A fresh handle on that one directory sees Foundry's, the Services' and GitHub's rows.
    const probe = createFeltDB({ namespace: 'probe', mode: 'local', path: directory })
    expect(((await probe.collection('Workspace').get(project.id)) as { name?: string } | null)?.name).toBe('Shared')
    expect((await probe.collection('api_keys').all()).length).toBe(1)
    expect(((await probe.collection('GitHubConnection').get('douchat-github')) as { authMechanism?: string } | null)?.authMechanism).toBe('public')
    await probe.close()

    // There is one flow: nothing beside it, and no second store next to the app or under the working directory.
    expect(flowFiles(directory).filter(name => !name.endsWith('.journal'))).toEqual(['blobs', 'desktop.lock', 'state.json'])
    expect(existsSync(join(process.cwd(), '.appport'))).toBe(false)
    expect(existsSync(join(process.cwd(), '.feltdb'))).toBe(false)
    expect(readdirSync(booted.root).filter(name => /appport|github|services|\.flow$/i.test(name) && name !== 'appport-api-key')).toEqual([])
    await services.apiKeys.close()
  }, 60_000)

  it('keeps every application’s state across a restart, in the same flow, without creating another', async () => {
    const { booted, directory, services, github } = await world()
    const path = kit.repository()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Shared')
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look.', { action: 'none' }) })).id))!
    const { secret } = await ensureClientApiKey(services, booted.root)
    await connectGitHub(github, booted.desktop.vault)
    const root = booted.root
    await services.apiKeys.close()
    await kit.shutdown(booted)

    const again = await kit.boot(root)
    expect(again.desktop.databaseDirectory).toBe(directory)
    expect((await again.desktop.repository.codingSession(session.id))?.status).toBe('succeeded')
    const services2 = openDesktopServices(directory)
    const github2 = openDesktopGitHub(directory, again.desktop.vault)
    expect(await services2.apiKeys.authenticateApiKey(secret)).toMatchObject({ applicationId: 'ai.douchat.desktop' })
    expect((await github2.getConnection('douchat-github'))?.status).toBe('configured')
    expect(readdirSync(join(directory, '..')).filter(name => name !== 'felt' && /felt|flow/i.test(name))).toEqual([])
    await services2.apiKeys.close()
  }, 90_000)

  it('declares each owner’s collections in desktop.flow exactly as its own contract does, with no name collisions', async () => {
    const { services, github, booted } = await world()
    const flow = desktopFlow()
    const names = flow.collections.map(collection => collection.name)
    expect(new Set(names).size).toBe(names.length)
    const fieldsOf = (spec: ReturnType<typeof parseFlowSpec>, name: string) => JSON.stringify(spec.collections.find(collection => collection.name === name))
    const githubFlow = parseFlowSpec(await github.flow())
    for (const collection of githubFlow.collections) expect(fieldsOf(flow, collection.name)).toBe(fieldsOf(githubFlow, collection.name))
    const servicesFlow = parseFlowSpec(readFileSync(join(process.cwd(), 'node_modules/@appport/services/appport.flow'), 'utf8'))
    for (const name of ['ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents', 'ServiceEffectEvidence']) expect(fieldsOf(flow, name)).toBe(fieldsOf(servicesFlow, name))
    // Foundry's own collections share no name with either provider's.
    const owned = names.filter(name => !githubFlow.collections.some(item => item.name === name) && !servicesFlow.collections.some(item => item.name === name))
    expect(owned).toContain('CodingSession')
    expect(owned.filter(name => /^(GitHub|ApiKey|Webhook|Job|Secret|Notification|File|Configuration)/.test(name))).toEqual([])

    // What is physically stored is declared by exactly one owner.
    await ensureClientApiKey(services, booted.root)
    await connectGitHub(github, booted.desktop.vault)
    await booted.coding.addProject(kit.repository())
    const stored = physicalCollections(booted.desktop.databaseDirectory)
    const servicesPhysical = new Set(['api_keys', 'api_key_prefixes', 'api_key_audit_events', 'service_effect_evidence'])
    for (const name of stored) expect(names.includes(name) || servicesPhysical.has(name) || name === '__indexes__', `unowned collection ${name}`).toBe(true)
    await services.apiKeys.close()
  }, 60_000)
})

describe('@appport/github as the GitHub capability', () => {
  it('keeps the credential out of the flow: FeltDB holds a reference, the vault holds the secret', async () => {
    const { booted, directory, github, services } = await world()
    const token = 'ghp_TESTONLY_credential_0123456789abcdef'
    await connectGitHub(github, booted.desktop.vault, token)
    const connection = (await github.getConnection('douchat-github'))!
    expect(connection).toMatchObject({ authMechanism: 'personal_access_token', credentialReference: { secretId: 'douchat-github-token', tenantId: 'local' } })
    expect(JSON.stringify(connection)).not.toContain(token)
    expect(allText(directory)).not.toContain(token)
    expect(booted.desktop.vault.get('github:douchat-github-token')).toBe(token)
    // Neither is it in the vault file in the clear (the test codec is base64; the real one is the OS keychain).
    const vaultText = readdirSync(join(booted.root, 'credentials')).map(name => readFileSync(join(booted.root, 'credentials', name), 'utf8')).join('\n')
    expect(vaultText.length).toBeGreaterThan(0)
    expect(vaultText.includes(token)).toBe(false)
    await services.apiKeys.close()
  }, 30_000)

  it('is asked for repository metadata through its own operation; Git supplies the local remote', async () => {
    const { booted, github, services } = await world()
    const path = kit.repository()
    kit.git(path, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git')
    const project = await booted.coding.addProject(path, 'Widget')
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input)
      seen.push(url)
      return new Response(JSON.stringify({ id: 42, node_id: 'R_x', name: 'widget', full_name: 'acme/widget', private: false, archived: false, default_branch: 'trunk', html_url: 'https://github.com/acme/widget', owner: { login: 'acme' } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    await connectGitHub(github, booted.desktop.vault)
    const api = new CodingApi(booted.desktop.repository, booted.coding, () => undefined)
    const view = await projectRemote(github, await api.getProject(project.id), await api.remoteUrl(project.id))
    expect(view.local).toEqual({ path, remoteUrl: 'git@github.com:acme/widget.git' })
    expect(view.github).toMatchObject({ fullName: 'acme/widget', defaultBranch: 'trunk', private: false })
    expect(seen.some(url => url.includes('api.github.com/repos/acme/widget'))).toBe(true)

    // Through AppPort: the Foundry capability delegates; it does not reimplement.
    const authenticate = apiKeyAuthenticator(services)
    const { secret } = await ensureClientApiKey(services, booted.root)
    const app = createFoundryAppPort(api, authenticate, async id => projectRemote(github, await api.getProject(id), await api.remoteUrl(id)))
    const client = createClient({ transport: createInProcessTransport({ server: app.server, identity: await app.server.identify({ transport: 'inprocess', headers: { authorization: `Bearer ${secret}` } }) }) })
    await client.connect()
    expect(await client.call('douchat.projects.remote', { id: project.id })).toMatchObject({ projectId: project.id, github: { fullName: 'acme/widget' } })
    await client.close(); app.close(); await services.apiKeys.close()

    // A non-GitHub remote is Git's business only: the capability is not consulted.
    expect(parseGitHubRemote('https://gitlab.com/acme/widget.git')).toBeUndefined()
    expect(parseGitHubRemote('https://github.com/acme/widget.git')).toEqual({ owner: 'acme', repository: 'widget' })
  }, 60_000)

  it('does not write GitHub, Services or FeltDB logic of its own, and never stores source', async () => {
    const root = join(process.cwd(), 'src', 'main')
    const files: string[] = []
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|testkit|testSupport/.test(entry.name)) files.push(full) } }
    walk(root)
    const sources = files.map(file => [file, readFileSync(file, 'utf8')] as const)
    // No GitHub API code of Foundry's own for repositories, issues, branches or pull requests. Two older, unrelated features
    // talk to GitHub directly and are pinned here so that no third can appear: the release check of the local agent CLIs
    // and the skill installer's download of a skill package. Neither is a project/coding operation; both are candidates to move
    // onto the capability later.
    const talksToGitHub = sources.filter(([, source]) => /api\.github\.com|@octokit|octokit/i.test(source)).map(([file]) => file.replace(`${root}/`, '')).sort()
    expect(talksToGitHub).toEqual(['localAgentUpdates.ts', 'skillInstallation.ts'])
    // Exactly one place opens FeltDB directly: the desktop's own database. AppPort code reaches it through the capabilities.
    expect(sources.filter(([, source]) => /\bcreateFeltDB\(/.test(source)).map(([file]) => file.replace(`${root}/`, ''))).toEqual(['felt/database.ts'])
    for (const [file, source] of sources.filter(([file]) => file.includes('/appport/'))) expect(source, file).not.toMatch(/createFeltDB|new Map\(|MemorySessionStore|desktopRepository|writeFileSync\(/)

    // Git and the filesystem hold the source; the flow holds none of it.
    const { booted, directory, services } = await world()
    const path = kit.repository()
    writeFileSync(join(path, 'src', 'unique.js'), '// SOURCE-MARKER-9f3b1c not for FeltDB\n')
    const project = await booted.coding.addProject(path)
    const agent = await kit.scriptedAgent(booted)
    await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix.', { action: 'fix-add' }) })).id)
    expect(allText(directory)).not.toContain('SOURCE-MARKER-9f3b1c')
    expect(allText(directory)).not.toContain('return a + b')
    await services.apiKeys.close()
  }, 60_000)

  it('is reachable by an authorized local owner only, and never for mutation', async () => {
    const { github, services } = await world()
    await connectGitHub(github, { set: () => undefined } as never)
    // Mutations are not in the local owner's authority, so the capability refuses before any provider call.
    await expect(github.issues.create({ connectionId: 'douchat-github', owner: 'a', repository: 'b', title: 't' } as never, { applicationId: 'ai.douchat.desktop' })).rejects.toThrow(/github\.issue\.create/)
    await services.apiKeys.close()
  }, 30_000)
})

declare module 'vitest' { interface ProvidedContext { _unused?: Booted } }
