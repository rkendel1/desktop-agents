import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { JevService } from './jev'
import type { JevQuestion } from '../shared/jev'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

it('dogfoods the single durable authority invariant using evidence derived from the real Foundry repository', async () => {
  const repository = join(__dirname, '../..')
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const production = sourceFiles(join(repository, 'src')).map(path => ({ path: relative(repository, path), text: readFileSync(path, 'utf8') }))
  const flow = readFileSync(join(repository, 'src/main/felt/desktop.flow'), 'utf8')
  const authority = readFileSync(join(repository, 'src/main/authority.test.ts'), 'utf8')
  const durableStores = [
    ...(manifest.dependencies['@feltdb/core'] ? ['FeltDB'] : []),
    ...(production.some(file => /(?:better-sqlite3|node:sqlite|FileJsDb)/.test(file.text) && !file.path.endsWith('legacy/migrate.ts')) ? ['other'] : [])
  ]
  const collections = [...flow.matchAll(/^\s*collection (\w+) \{/gm)].map(match => match[1]!)
  const inputs: JevQuestion['inputs'] = [
    { id: 'durable-stores', name: 'durableStores', value: durableStores },
    { id: 'collections', name: 'collections', value: collections },
    { id: 'authority-guard', name: 'authorityGuard', value: authority.includes("describe('FeltDB authority'") },
    { id: 'feltdb-imports', name: 'feltDbImports', value: production.filter(file => file.text.includes("from '@feltdb/core'")).map(file => file.path) }
  ]
  const result = await new JevService().evaluate({
    id: 'dogfood-single-durable-authority', subject: { kind: 'architecture', id: 'foundry' },
    question: 'Does Foundry maintain FeltDB as the single durable authority for application, session, and evaluation state?', inputs,
    rules: [
      { id: 'single-durable-authority', expression: 'exactlyOne(durableStores)' },
      { id: 'has-evidence', expression: 'contains(collections, "Evidence")' },
      { id: 'has-evaluations', expression: 'contains(collections, "Evaluation")' },
      { id: 'has-decisions', expression: 'contains(collections, "Decision")' },
      { id: 'guarded', expression: 'equals(authorityGuard, true)' },
      { id: 'single-feltdb-boundary', expression: 'exactlyOne(feltDbImports)' }
    ], requestedDecision: 'pass-fail-review'
  })
  expect(result.decision.status).toBe('pass')
  expect(result.evaluations).toHaveLength(6)
  expect(result.provenance).toMatchObject({ runtime: 'deterministic', model: 'none' })
  expect(result.metrics.modelMs).toBe(0)
})
