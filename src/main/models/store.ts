import type { DesktopRepository } from '../desktopRepository'
import type { FabricStore } from './fabric'

/** The fabric’s policy and last discovery live in Foundry’s existing settings (FeltDB `Setting`), beside every other preference — no store of its own. */
export const FABRIC_SETTING = 'modelFabric'
export const settingsFabricStore = (repository: Pick<DesktopRepository, 'setting' | 'setSetting'>): FabricStore => ({
  load: () => repository.setting<unknown>(FABRIC_SETTING),
  save: value => repository.setSetting(FABRIC_SETTING, value)
})
