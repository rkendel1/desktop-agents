import { existsSync, readFileSync } from 'node:fs'
import type { DesktopRepository } from '../desktopRepository'
import { customDefinition } from '../localAgents'

const IMPORTED = 'localAgentsImported'

/**
 * Earlier releases kept the owner's custom agents in `local-agents.json` beside
 * the database. They belong in FeltDB with the rest of the desktop's state, so the
 * file is read once and its entries added (an id already in FeltDB is not
 * overwritten). The file itself is never modified or deleted, and it is not read
 * again: an agent removed afterwards stays removed.
 */
export async function importLocalAgentFile(repository: DesktopRepository, file: string): Promise<number> {
  if (await repository.setting(IMPORTED)) return 0
  let added = 0
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        const current = await repository.localAgentDefinitions()
        const known = new Set(current.map(item => item.id))
        const imported = parsed.map(customDefinition).filter((item): item is NonNullable<ReturnType<typeof customDefinition>> => Boolean(item) && !known.has(item!.id))
        if (imported.length) await repository.replaceLocalAgentDefinitions([...current, ...imported])
        added = imported.length
      }
    } catch { /* An unreadable file is left as it is; nothing was imported. */ }
  }
  await repository.setSetting(IMPORTED, { at: Date.now(), added })
  return added
}
