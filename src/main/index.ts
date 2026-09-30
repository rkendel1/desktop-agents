import { groupMemberSessionId } from '../shared/bot/group'
import type { SelectedMention } from '../shared/bot/mentions'
import { supportedInterfaceLanguage } from '../shared/language'
import { LocalDesktopData } from './desktopData'
import { LOCAL_USER_ID } from '../shared/userMemory'
import { startDesktop, stopDesktop, DesktopStartupError, type DesktopState } from './desktop'
import { exportAgentArchive, parseAgentArchive } from './agentArchive'
import { parseSkillArchive } from './skillArchive'
import { replyToIM } from './imReply'
import { IMChannelManager } from './imChannels'
import { testLocalAgent } from './localAgentTest'
import { listLocalAgentModels, cancelLocalModelQueries } from './localAgentModels'
import { localModelId, configurableLocalAgents } from '../shared/localModels'
import { thinkingLevel } from '../shared/thinkingLevels'
import { authorizeTokenDance } from './tokenDanceAuth'
import { CUSTOM_PROVIDER_PREFIX, type CustomProviderInput, type CustomModelTest } from '../shared/customModels'
import { detectOllama } from './customModels'
import { configureManagedNode, ensureManagedNode } from './managedNode'
import { configureNativeDialogWindows, resizeNativeDialog } from './nativeDialogs'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { DiagnosticLog } from './diagnostics'
import { release as osRelease } from 'node:os'
import { notifyWindows } from './windowNotifications'
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, powerSaveBlocker, session, shell, safeStorage, systemPreferences } from 'electron'
import electronUpdater from 'electron-updater'
import type {
  CodeArtifactInput,
  EmailConnectorInput,
  CreateAgentInput,
  CustomLocalAgentInput,
  MessageImageInput,
  MessageFileInput,
  CreateGroupInput,
  CreateRoutineInput,
  GitDiffMode,
  UpdateAgentInput,
  UpdateConversationInput,
  UpdateProfileInput,
  UpdateState
} from '../shared/types'
import { LocalComputerProvider } from './computer'
import { DouchatRuntime } from './runtime'
import { RoutineScheduler } from './scheduler'
import { CodingService } from './coding/service'
import { CiService } from './ci/service'
import { CodingApi } from './coding/api'
import { ComputeClient } from './compute/client'
import { startAppPortHost, type AppPortHost } from './appport/host'
import { openDesktopServices } from './appport/services'
import { connectGitHub, openDesktopGitHub, projectRemote } from './appport/github'
import type { GitHubIntegration } from '@appport/github'
import type { AppPortServices } from '@appport/services'
import { formatCommandLine, parseCommandLine } from '../shared/coding'
import { DesktopRepository } from './desktopRepository'
import { DesktopProjection } from './projection'
import { addCustomLocalAgent, detectLocalAgents, removeCustomLocalAgent, updateLocalAgent, validateLocalAgent } from './localAgents'
import { checkLocalAgentUpdates } from './localAgentUpdates'
import { resetShellPath } from './shellPath'
import { DesktopUpdater, type UpdateDriver } from './updater'
import { EmailConnectorManager } from './emailConnector'
import type { SecretCodec } from './credentialVault'
import { applicationName, userDataDirectoryName } from './userData'
import { displayName, PRODUCT_TAGLINE } from '../shared/brand'
import { validateWorkspaceFolder, resolveSavedWorkspace, localWorkspace, openableWorkspace } from './localWorkspaces'
import { canAssignConversationWorkspace } from '../shared/conversationWorkspace'
import { prepareNpmMaintenance, resolveMaintenancePlan } from './localAgentMaintenance'
import { openMaintenanceTerminal, openLocalAgentTerminal } from './terminalLauncher'

// Use the software compositor on Windows: modal layers can blank the entire
// window on affected GPU/driver combinations. Must run before app readiness.
if (process.platform === 'win32') app.disableHardwareAcceleration()

const development = !app.isPackaged
// Compatibility, not branding: Chromium derives the macOS safeStorage Keychain service from the application
// name, so it stays "Douchat Safe Storage" (and "Douchat Dev Safe Storage" for local builds, which never contend
// with the signed release's credentials). What a person sees is Foundry — see the menu, About panel and window
// titles below and docs/foundry-identifiers.md.
app.setName(applicationName(development))
const appIcon = join(app.getAppPath(), 'resources/icons', development ? 'foundry-dev.png' : 'foundry.png')

/**
 * Keep packaged user data stable across display-name changes, while isolating
 * local development so test logins, screenshots and database resets cannot
 * overwrite a user's installed data. (The directory keeps its original name: it is where the FeltDB flow lives.)
 */
app.setPath('userData', join(app.getPath('appData'), userDataDirectoryName(development)))
configureManagedNode(app.getPath('userData'))
/** Provider secrets go through the operating system's credential store, never into FeltDB. */
const credentialCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
}
async function reloadCustomModels(): Promise<void> {
  try { await runtime.configureCustomModels(await desktop.providers.records(), (await desktop.providers.list()).defaultModel) }
  catch { await runtime.configureCustomModels([]); console.warn('[foundry] Provider keys could not be loaded') }
}
const diagnostics = new DiagnosticLog(join(app.getPath('userData'), 'logs'))
try {
  const crashDirectory = join(diagnostics.directory, 'crashes')
  mkdirSync(crashDirectory, { recursive: true })
  app.setPath('crashDumps', crashDirectory)
  crashReporter.start({ uploadToServer: false })
  diagnostics.write('crash-reporter.ready', 'Local dumps: logs/crashes; upload disabled')
} catch (error) {
  diagnostics.write('crash-reporter.failed', error instanceof Error ? error.message : String(error))
}

diagnostics.write('app.start', JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, os: osRelease(), electron: process.versions.electron, chrome: process.versions.chrome, hardwareAccelerationDisabled: process.platform === 'win32' }))
process.on('uncaughtExceptionMonitor', (error) => diagnostics.write('main.uncaughtException', error.stack || error.message))
const settingsTimers = new Map<number, ReturnType<typeof setTimeout>>()
function clearSettingsTimer(id: number): void {
  clearTimeout(settingsTimers.get(id))
  settingsTimers.delete(id)
}
/** Native dialogs follow the renderer's interface language; before the runtime
 * exists (early crashes) they fall back to the system locale. */
function ui(en: string, zh: string): string {
  return (runtime ? runtime.language : supportedInterfaceLanguage(app.getLocale())) === 'zh-CN' ? zh : en
}
async function openDiagnosticLogs(): Promise<void> {
  diagnostics.write('logs.open')
  const error = await shell.openPath(diagnostics.directory)
  if (error) {
    diagnostics.write('logs.open-failed', error)
    dialog.showErrorBox('Foundry', `${ui('Could not open the log folder:', '无法打开日志目录：')} ${diagnostics.directory}\n${error}`)
  }
}
app.on('browser-window-created', (_event, window) => {
  const contents = window.webContents
  const id = contents.id
  configureNativeDialogWindows(window)
  const record = (event: string, detail = '') => diagnostics.write(event, `window=${id} ${detail}`)
  contents.on('preload-error', (_event, _path, error) => record('preload.error', error.stack || error.message))
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => record('window.load-failed', JSON.stringify({ code, description, mainFrame })))
  let showingCrashDialog = false
  contents.on('render-process-gone', (_event, details) => {
    record('renderer.gone', JSON.stringify({ ...details, settingsPending: settingsTimers.has(id) }))
    clearSettingsTimer(id)
    if (details.reason === 'clean-exit' || showingCrashDialog || window.isDestroyed()) return
    showingCrashDialog = true
    // Native UI remains usable after the renderer (including its React boundaries) exits.
    void dialog.showMessageBox(window, {
      type: 'error', title: 'Foundry', message: ui('The interface stopped unexpectedly', '界面进程意外退出'),
      detail: `${ui('Please send diagnostics.log and the crashes folder from the log folder to the developers.', '请将日志目录中的 diagnostics.log 和 crashes 文件夹发给开发者。')}\n${ui('Error:', '错误：')} ${details.reason} (${details.exitCode})`,
      buttons: [ui('Open log folder and reload', '打开日志目录并重新加载'), ui('Reload', '重新加载'), ui('Close window', '关闭窗口')], defaultId: 0, cancelId: 2
    }).then(async ({ response }) => {
      if (response === 0) await openDiagnosticLogs()
      if (window.isDestroyed() || contents.isDestroyed()) return
      if (response === 2) window.close()
      else contents.reload()
    }).catch((error) => record('crash-dialog.failed', String(error)))
      .finally(() => { showingCrashDialog = false })
  })
  window.on('unresponsive', () => record('window.unresponsive'))
  window.on('responsive', () => record('window.responsive'))
  window.on('closed', () => clearSettingsTimer(id))
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      void openDiagnosticLogs()
    }
  })
})
app.on('child-process-gone', (_event, details) => diagnostics.write('child-process.gone', JSON.stringify(details)))
ipcMain.handle('douchat:resize-dialog', async (event, name: unknown, width: unknown, height: unknown) => {
  if (typeof name !== 'string' || typeof width !== 'number' || typeof height !== 'number') return false
  return resizeNativeDialog(event.sender, name, height, width)
})
ipcMain.on('douchat:diagnostic', (event, name: unknown, detail: unknown) => {
  if (!isDouchatRenderer(event.sender) || typeof name !== 'string' || typeof detail !== 'string' || name.length > 100 || detail.length > 16000) return
  if (name === 'native-dialog.resize') {
    try {
      const request = JSON.parse(detail)
      if (typeof request.name === 'string' && typeof request.height === 'number') resizeNativeDialog(event.sender, request.name, request.height)
    } catch { /* Ignore malformed resize requests. */ }
    return
  }
  const id = event.sender.id
  diagnostics.write(name, `window=${id} ${detail}`)
  if (name === 'settings.open-request') {
    clearSettingsTimer(id)
    settingsTimers.set(id, setTimeout(() => {
      settingsTimers.delete(id)
      diagnostics.write('settings.render-timeout', `window=${id} No layout acknowledgement within 5 seconds`)
    }, 5000))
  } else if (name === 'settings.layout' || name === 'settings.close' || name === 'dialog.render-error') clearSettingsTimer(id)
})
ipcMain.handle('douchat:open-diagnostic-logs', async (event) => {
  if (!isDouchatRenderer(event.sender)) return
  await openDiagnosticLogs()
})


let mainWindow: BrowserWindow | null = null
let desktop: DesktopState
let store: DesktopRepository
let imChannels: IMChannelManager | undefined
let runtime: DouchatRuntime
let computer: LocalComputerProvider
let scheduler: RoutineScheduler
let updater: DesktopUpdater
let emailConnectors: EmailConnectorManager
let projection: DesktopProjection
let coding: CodingService
let ci: CiService
let computeClient: ComputeClient
let codingApi: CodingApi
let appPort: AppPortHost | undefined
let appPortServices: AppPortServices | undefined
let appPortGitHub: GitHubIntegration | undefined

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function focusMainWindow(): void {
  if (quitting) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && runtime) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.show()
  mainWindow.focus()
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => focusMainWindow())
}

let localWorkBlocker: number | undefined
let quitting = false
/** Something that exists only while the app runs changed: keep the machine awake while a local agent works, and tell the renderer. */
function ephemeralChanged(): void {
  if (quitting) return
  const localWork = runtime?.hasLocalAgentWork() ?? false
  if (localWork && localWorkBlocker === undefined) localWorkBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!localWork && localWorkBlocker !== undefined) {
    powerSaveBlocker.stop(localWorkBlocker)
    localWorkBlocker = undefined
  }
  projection?.ephemeralChanged()
}

function broadcastUpdate(state: UpdateState): void {
  notifyWindows(BrowserWindow.getAllWindows(), 'douchat:update-state', state)
}

const chatWindows = new Map<string, BrowserWindow>()
async function openChatWindow(conversationId: string): Promise<void> {
  const existing = chatWindows.get(conversationId)
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return }
  const title = (await store.conversation(conversationId))?.name
  const window = new BrowserWindow({ acceptFirstMouse: true, icon: appIcon, width: 820, height: 720, minWidth: 480, minHeight: 480, title,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  chatWindows.set(conversationId, window)
  window.on('closed', () => chatWindows.delete(conversationId))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('conversation', conversationId)
    void window.loadURL(url.toString())
  } else void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { conversation: conversationId } })
}

const codeArtifacts = new Map<string, CodeArtifactInput>()
const codeArtifactWindows = new Map<string, BrowserWindow>()

function validateCodeArtifact(input: CodeArtifactInput): CodeArtifactInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid code file')
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : ''
  const language = typeof input.language === 'string' ? input.language.trim().toLowerCase().slice(0, 32) : ''
  const code = typeof input.code === 'string' ? input.code : ''
  if (!title || !language || !code || code.length > 2_000_000) throw new Error('Invalid code file')
  return { title, language, code }
}

function openCodeArtifactWindow(input: CodeArtifactInput): void {
  const artifact = validateCodeArtifact(input)
  const artifactId = randomUUID()
  const window = new BrowserWindow({ acceptFirstMouse: true,
    icon: appIcon,
    width: 1120,
    height: 760,
    minWidth: 680,
    minHeight: 480,
    title: artifact.title,
    show: false,
    backgroundColor: '#F6F7FA',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  codeArtifacts.set(artifactId, artifact)
  codeArtifactWindows.set(artifactId, window)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    codeArtifactWindows.delete(artifactId)
    codeArtifacts.delete(artifactId)
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  // The preview iframe may run the supplied page's scripts, but it may not
  // navigate itself to a remote document (which would discard our CSP).
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('artifact', artifactId)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { artifact: artifactId } })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({ acceptFirstMouse: true,
    icon: appIcon,
    width: 1240,
    height: 800,
    // Rail + inbox + chat + activity rail all need room at once.
    minWidth: 1060,
    minHeight: 600,
    show: false,
    backgroundColor: '#F6F7FA',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // macOS native controls exceed the compact 60px rail on newer systems.
  // The renderer supplies compact controls backed by native window actions.
  if (process.platform === 'darwin') mainWindow.setWindowButtonVisibility(false)

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function validateRoutineInput(input: CreateRoutineInput): Promise<void> {
  if (!input.name?.trim() || !input.prompt?.trim()) throw new Error('Routine name and instructions are required')
  if (!(await store.agent(input.agentId))) throw new Error('Routine agent not found')
  if (!(await store.conversation(input.conversationId))) {
    throw new Error('Routine conversation not found')
  }
  if (input.schedule.kind === 'once') {
    if (!Number.isFinite(input.schedule.runAt) || input.schedule.runAt <= Date.now()) {
      throw new Error('One-time routine must be scheduled in the future')
    }
  } else if (input.schedule.kind === 'interval') {
    if (!Number.isFinite(input.schedule.intervalMinutes) || input.schedule.intervalMinutes < 1) {
      throw new Error('Routine interval must be at least one minute')
    }
  } else {
    if (!input.schedule.days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.time)) {
      throw new Error('Choose at least one day and a valid time')
    }
  }
}

function isDouchatRenderer(contents: Electron.WebContents | null): boolean {
  return Boolean(contents && BrowserWindow.getAllWindows().some((window) => window.webContents === contents))
}

function configureMediaPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    permission === 'media'
    && isDouchatRenderer(contents)
    && details.isMainFrame
    && details.mediaType === 'audio'
  ))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      permission === 'media'
      && isDouchatRenderer(contents)
      && details.isMainFrame
      && Boolean(mediaTypes?.includes('audio'))
      && !mediaTypes?.includes('video')
    )
  })
}

/** Everything a person reads as the product's name: the About panel and, on macOS, the application menu. */
function configureBrand(): void {
  const name = displayName(development)
  app.setAboutPanelOptions({ applicationName: name, applicationVersion: app.getVersion(), copyright: PRODUCT_TAGLINE })
  if (process.platform !== 'darwin') return
  // The default menu is named after the (compatibility) application name, so the same standard menu is spelled out with Foundry's.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [{ role: 'about', label: `About ${name}` }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide', label: `Hide ${name}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${name}` }] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  // Electron creates a default File/Edit/View/Window menu on Windows when no
  // application menu is provided. Foundry exposes its actions in the app UI,
  // so remove the native menu instead of merely hiding it until Alt is pressed.
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  configureMediaPermissions()
  app.dock?.setIcon(appIcon)
  configureBrand()
  ipcMain.on('douchat:window-action', (event, action: string) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (action === 'close') mainWindow.close()
    else if (action === 'minimize') mainWindow.minimize()
    else if (action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })
  const requireConversation = async (id: unknown) => {
    const conversation = typeof id === 'string' ? await store.conversation(id) : undefined
    if (!conversation) throw new Error('Chat not found')
    return conversation
  }
  const requireAgent = async (id: unknown) => {
    const agent = typeof id === 'string' ? await store.agent(id) : undefined
    if (!agent) throw new Error('Agent not found')
    return agent
  }
  ipcMain.handle('douchat:set-interface-language', async (_event, language: unknown) => {
    runtime.setInterfaceLanguage(typeof language === 'string' ? language : '')
  })
  // The desktop's durable state is FeltDB. It is opened first, before any
  // window, and a failure stops the app here instead of falling back.
  try {
    desktop = await startDesktop({ userData: app.getPath('userData'), codec: credentialCodec, demo: process.env.DOUCHAT_DEMO === '1' })
  } catch (error) {
    const detail = error instanceof DesktopStartupError ? error.message : String(error)
    diagnostics.write('desktop.start-failed', error instanceof Error ? error.stack || detail : detail)
    dialog.showErrorBox('Foundry', `${ui('Foundry could not open its local data and will close.', 'Foundry 无法打开本地数据，即将退出。')}\n\n${detail}`)
    quitting = true
    app.exit(1)
    return
  }
  store = desktop.repository
  diagnostics.write('desktop.started', JSON.stringify({ database: desktop.databaseDirectory, migration: desktop.migration.status, imported: desktop.migration.imported }))
  emailConnectors = new EmailConnectorManager(store, desktop.vault)
  computer = new LocalComputerProvider(
    () => ephemeralChanged(),
    [app.getPath('downloads'), app.getPath('desktop'), app.getPath('documents')],
    (path) => shell.openPath(path)
  )
  runtime = new DouchatRuntime(store, computer, ephemeralChanged, { snapshot: () => emailConnectors.snapshot(), createTools: id => emailConnectors.createTools(id) })
  // FeltDB announces every durable change; the projection turns each into a small delta for the renderer.
  projection = new DesktopProjection(store, {
    ephemeral: () => ({ ...runtime.ephemeralState(), codingActivity: coding?.activity() ?? [] }),
    runtimeStatus: agents => runtime.runtimeStatus(agents),
    availableModels: () => runtime.availableModels(),
    connectors: () => emailConnectors.snapshot()
  }, delta => { if (!quitting) notifyWindows(BrowserWindow.getAllWindows(), 'douchat:projection', delta) })
  projection.start()
  imChannels = new IMChannelManager(desktop.imStorage, () => LOCAL_USER_ID, async id => Boolean(await store.agent(id)),
  (agent, thread, text, signal, provider, media, receiptId) => replyToIM(store, runtime, agent, thread, text, signal, provider, media, receiptId), (input, init) => net.fetch(String(input), init),
  (agent, thread, text, provider, messageId) => runtime.receiveIMMessage(agent, thread, text, provider, messageId),
  (event, detail) => diagnostics.write(event, detail))
  ipcMain.handle('douchat:im-list', async (_event, agent) => imChannels!.list(agent))
  ipcMain.handle('douchat:im-connect', async (_event, agent, input) => imChannels!.connect(agent, input))
  ipcMain.handle('douchat:im-disconnect', async (_event, agent, provider) => imChannels!.disconnect(agent, provider))
  ipcMain.handle('douchat:im-login', async (_event, agent) => imChannels!.login(agent))
  ipcMain.handle('douchat:im-cancel-login', async (_event, agent, session) => imChannels!.cancelLogin(agent, session))
  ipcMain.handle('douchat:im-status', async (_event, agent, session) => imChannels!.loginStatus(agent, session))
  runtime.setInterfaceLanguage(app.getLocale())
  scheduler = new RoutineScheduler(store, runtime)
  runtime.setRoutineCreator((input) => scheduler.createRoutine(input))
  computeClient = new ComputeClient()
  coding = new CodingService(store, runtime, () => ephemeralChanged(), { compute: computeClient })
  // The one place approvals are answered: the desktop prompt and a remote client both end up here.
  const answerPermission = (id: string, allow: boolean): void => { runtime.resolveAgentPermission(id, allow); ephemeralChanged() }
  ci = new CiService(store, { compute: computeClient })
  codingApi = new CodingApi(store, coding, answerPermission, computeClient, ci)
  // A run left `running` by a Foundry that is gone: its Computer is released through Compute now.
  void ci.recover().catch(error => diagnostics.write('ci.recover.failed', error instanceof Error ? error.message : String(error)))
  coding.announceInterrupted(store.recoveredCodingSessions)
  // Remote control is off unless the owner turns it on. It listens on loopback only and needs the API key in `appport-api-key`.
  if (process.env.DOUCHAT_APPPORT === '1') {
    try {
      appPortServices = openDesktopServices(desktop.databaseDirectory)
      const github = openDesktopGitHub(desktop.databaseDirectory, desktop.vault)
      appPortGitHub = github
      // A public connection (no credential) exists from the start; a token, if the owner adds one, is kept in the vault and only referenced.
      if (!(await github.getConnection('douchat-github'))) await connectGitHub(github, desktop.vault)
      appPort = await startAppPortHost({ api: codingApi, services: appPortServices,
        remote: async projectId => { const project = await codingApi.getProject(projectId); return projectRemote(github, project, await codingApi.remoteUrl(projectId)) }, directory: app.getPath('userData'), port: Number(process.env.DOUCHAT_APPPORT_PORT) || 0 })
      diagnostics.write('appport.started', JSON.stringify({ url: appPort.url, keyFile: appPort.keyFile }))
    } catch (error) { diagnostics.write('appport.failed', error instanceof Error ? error.stack || error.message : String(error)) }
  }
  const updateDriver = app.isPackaged
    ? electronUpdater.autoUpdater as unknown as UpdateDriver
    : undefined
  updater = new DesktopUpdater(
    updateDriver,
    app.getVersion(),
    app.isPackaged,
    () => runtime.ephemeralState().activity.length,
    broadcastUpdate
  )
  ipcMain.handle('douchat:user-memory', async (event, agentId?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).getUserMemory(agentId)
  })
  ipcMain.handle('douchat:save-user-memory', async (event, document: import('../shared/userMemory').UserMemoryDocument, agentId?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).saveUserMemory(document, agentId)
  })
  ipcMain.handle('douchat:group-memory', async (event, conversationId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).getGroupMemory(conversationId)
  })
  ipcMain.handle('douchat:save-group-memory', async (event, document: import('../shared/userMemory').UserMemoryDocument, conversationId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).saveGroupMemory(document, conversationId)
  })
  ipcMain.handle('douchat:request-microphone-access', async (event) => {
    if (!isDouchatRenderer(event.sender)) return 'denied'
    if (process.platform !== 'darwin') return 'granted'
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return 'granted'
    if (status === 'restricted') return 'denied'
    // Some development signatures report `denied` before TCC has created an
    // entry. askForMediaAccess() is the call that actually registers the app
    // and presents the first-use system prompt. For a genuine prior denial it
    // simply resolves false without displaying another prompt.
    return await systemPreferences.askForMediaAccess('microphone') ? 'granted' : 'denied'
  })
  ipcMain.handle('douchat:open-microphone-settings', async (event) => {
    if (!isDouchatRenderer(event.sender)) return
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone')
    } else if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone')
    }
  })
  ipcMain.handle('douchat:update-profile', async (event, input: UpdateProfileInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if (typeof input?.name === 'string') await store.setUserName(input.name)
    if (typeof input?.image === 'string') await store.setUserAvatar(input.image)
  })
  ipcMain.handle('douchat:complete-onboarding', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    await store.setSetting('onboarding', { completed: true, at: Date.now() })
  })
  ipcMain.handle('douchat:resolve-attention', async (event, id: string) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Unauthorized')
    await store.resolveAttention(id)
  })
  ipcMain.handle('douchat:get-update-state', async () => updater.state())
  ipcMain.handle('douchat:check-for-updates', async () => updater.checkForUpdates())
  ipcMain.handle('douchat:install-update', async () => updater.installUpdate())
  ipcMain.handle('douchat:maintain-local-agent', async (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Invalid local agent request')
    const agent = (await detectLocalAgents({ version: async () => undefined }, id))[0]
    if (!agent) throw new Error('Unknown local agent')
    const plan = await prepareNpmMaintenance(await resolveMaintenancePlan(agent))
    if (!plan.command) {
      await dialog.showMessageBox({ type: 'info', message: ui('Install or update this tool the way it was originally installed.', '请按该工具原有的安装方式安装或更新。'), detail: ui('Foundry does not run install commands for custom tools or tools from unconfirmed sources.', '自定义工具或未确认来源的工具不会自动运行安装命令。') })
      return false
    }
    const result = await dialog.showMessageBox({ type: 'question', message: `${agent.installed ? ui('Update', '更新') : ui('Install', '安装')} ${agent.name}`, detail: `${plan.needsDownload ? ui('First use: Foundry will download and verify a runtime first. This may take a few minutes.', '首次使用，需要先下载并校验运行环境，可能需要几分钟。') + '\n\n' : ''}${ui('The following command will run in your system terminal. Finish any prompts there; Foundry checks again when you return.', '将在系统终端执行以下命令。请在终端完成提示，返回后会自动检测。')}\n\n${plan.command}`, buttons: [ui('Cancel', '取消'), ui('Run in Terminal', '在终端执行')], defaultId: 1, cancelId: 0 })
    if (result.response !== 1) return false
    if (plan.needsDownload) await ensureManagedNode()
    resetShellPath()
    await openMaintenanceTerminal(plan.command)
    return true
  })
  ipcMain.handle('douchat:list-local-agent-models', async (_event, agentId: string) => {
    const agent = await store.agent(agentId)
    if (!agent?.localAgentId) throw new Error('Local agent not found')
    return listLocalAgentModels(agent.localAgentId)
  })
  ipcMain.handle('douchat:detect-local-agents', async () => { resetShellPath(); return checkLocalAgentUpdates(await detectLocalAgents()) })
  ipcMain.handle('douchat:open-local-agent-terminal', async (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || id !== 'claude') throw new Error('Invalid local agent terminal request')
    return openLocalAgentTerminal(id, {
      termanyAutomationAllowed: process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
    })
  })
  ipcMain.handle('douchat:add-custom-local-agent', async (event, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid custom local agent request')
    await addCustomLocalAgent(input)
    resetShellPath()
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  ipcMain.handle('douchat:update-local-agent', async (event, id: string, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Invalid local agent request')
    await updateLocalAgent(id, input)
    cancelLocalModelQueries()
    resetShellPath()
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  const localAgentTests = new Map<number, AbortController>()
  ipcMain.handle('douchat:test-local-agent', async (event, id: string | undefined, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender) || (id !== undefined && typeof id !== 'string')) throw new Error('Invalid local agent request')
    const senderId = event.sender.id
    if (localAgentTests.has(senderId)) throw new Error('A connection test is already running.')
    const abort = new AbortController()
    const cancel = () => abort.abort(new Error('Connection test cancelled.'))
    localAgentTests.set(senderId, abort)
    event.sender.once('destroyed', cancel)
    try { return await testLocalAgent(id, input, abort.signal) }
    finally { event.sender.removeListener('destroyed', cancel); localAgentTests.delete(senderId) }
  })
  ipcMain.handle('douchat:cancel-local-agent-test', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid local agent request')
    localAgentTests.get(event.sender.id)?.abort(new Error('Connection test cancelled.'))
  })
  ipcMain.handle('douchat:remove-custom-local-agent', async (event, id: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid custom local agent request')
    if ((await store.agents()).some((agent) => agent.localAgentId === id)) {
      throw new Error('Remove contacts using this local agent before deleting it.')
    }
    await removeCustomLocalAgent(id)
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  ipcMain.handle('douchat:search-messages', async (event, id: string, query: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).searchMessages(id, query)
  })
  ipcMain.handle('douchat:message-page', async (event, conversationId: string, topicId: string, before?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalDesktopData(store).getMessagePage(conversationId, topicId, before)
  })
  ipcMain.handle('douchat:copy-text', async (event, text: string) => {
    if (!isDouchatRenderer(event.sender) || typeof text !== 'string') throw new Error('Invalid clipboard request')
    clipboard.writeText(text)
  })
  ipcMain.handle('douchat:copy-attachment', async (event, attachmentId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof attachmentId !== 'string') throw new Error('Invalid clipboard request')
    const image = nativeImage.createFromDataURL(await store.attachmentDataUrl(attachmentId))
    if (image.isEmpty()) throw new Error('Image could not be copied')
    clipboard.writeImage(image)
  })
  ipcMain.handle('douchat:attachment-data', async (_event, attachmentId: string) => store.attachmentDataUrl(attachmentId))
  ipcMain.handle('douchat:open-local-file', async (event, path: string, conversationId?: string) => {
    if (!isDouchatRenderer(event.sender) || typeof path !== 'string' || (conversationId !== undefined && typeof conversationId !== 'string')) throw new Error('Invalid file request')
    const document = await store.ownedDocumentPath(path)
    if (document) {
      const error = await shell.openPath(document)
      if (error) throw new Error(error)
    } else await computer.openLocalFile(path, async () => {
      const conversation = conversationId ? await store.conversation(conversationId) : undefined
      if (!conversation || !canAssignConversationWorkspace(conversation)) return []
      const roots = [...(conversation.allowedFolders ?? []), ...(conversation.workspacePath ? [conversation.workspacePath] : [])]
      if (!conversation.workspacePath) {
        const topic = await store.activeTopicId(conversation.id)
        for (const id of conversation.agentIds) {
          const agent = (await store.agent(id))!
          const key = conversation.type === 'direct' ? `direct:${conversation.id}:${topic}` : groupMemberSessionId(conversation.id, id, topic)
          const workspace = await openableWorkspace(agent, key, conversation.type === 'group')
          if (workspace) roots.push(workspace.directory)
        }
      }
      return roots.flatMap(root => { try { return [resolveSavedWorkspace(root)] } catch { return [] } })
    })
  })
  // What a renderer needs to start: the current durable state, plus the sequence of the last change it already contains.
  ipcMain.handle('douchat:get-snapshot', () => projection.snapshot())

  const tokenDanceFlows = new Map<number, AbortController>()
  ipcMain.handle('douchat:authorize-tokendance', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const owner = event.sender.id
    tokenDanceFlows.get(owner)?.abort()
    const controller = new AbortController()
    tokenDanceFlows.set(owner, controller)
    const cancel = () => controller.abort()
    event.sender.once('destroyed', cancel)
    try {
      const key = await authorizeTokenDance(url => shell.openExternal(url), controller.signal)
      return key
    } finally {
      event.sender.removeListener('destroyed', cancel)
      if (tokenDanceFlows.get(owner) === controller) tokenDanceFlows.delete(owner)
    }
  })
  ipcMain.handle('douchat:cancel-tokendance', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    tokenDanceFlows.get(event.sender.id)?.abort()
  })
  ipcMain.handle('douchat:custom-models', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return desktop.providers.list()
  })
  ipcMain.handle('douchat:detect-ollama', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return detectOllama()
  })
  ipcMain.handle('douchat:decision-settings', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return store.decisionSettings()
  })
  ipcMain.handle('douchat:save-decision-settings', async (event, settings) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return runtime.saveDecisionSettings(settings)
  })
  ipcMain.handle('douchat:test-decision-settings', async (event, settings) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return runtime.testDecisionSettings(settings)
  })
  ipcMain.handle('douchat:save-custom-models', async (event, providers: CustomProviderInput[], defaultModel: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const result = await desktop.providers.save(providers, defaultModel)
    await reloadCustomModels()
    return result
  })
  ipcMain.handle('douchat:test-custom-model', async (event, input: CustomModelTest) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return desktop.providers.test(input)
  })
  ipcMain.handle('douchat:create-agent', async (event, input: CreateAgentInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if (input.customModel && input.localAgentId) throw new Error("Select one execution mode.")
    const localAgent = input.localAgentId ? await validateLocalAgent(input.localAgentId) : undefined
    // The main process owns runtime bindings: a renderer cannot choose a
    // provider or model by smuggling one over IPC.
    const binding = input.localAgentId
      ? { provider: 'local', model: 'default' }
      : input.customModel ? runtime.customAgentModel(input.customModel.providerId, input.customModel.model) : runtime.unconfiguredAgentModel()
    const { customModel: _selection, thinkingLevel: requestedThinking, ...agentInput } = input
    const agent = await store.createAgent({
      ...agentInput,
      thinkingLevel: binding.provider === 'local' || binding.provider.startsWith(CUSTOM_PROVIDER_PREFIX) ? thinkingLevel(requestedThinking) : undefined,
      avatar: agentInput.avatar || (agentInput.avatarEmoji ? undefined : localAgent?.avatar),
      localAgentName: localAgent?.custom ? localAgent.name : undefined,
      ...binding,
      followDefaultModel: input.customModel?.providerId === '@default'
    })
    const direct = (await store.conversations()).find(
      (conversation) => conversation.type === 'direct' && conversation.agentIds[0] === agent.id
    )
    // A new bot opens with its own proactive greeting, like a new topic does.
    if (direct) runtime.greetLater(direct.id)
    return { agentId: agent.id, ...(direct ? { conversationId: direct.id } : {}) }
  })
  ipcMain.handle('douchat:resolve-agent-permission', async (_event, id: string, allow: import('../shared/agentPermissions').PermissionApproval) => {
    runtime.resolveAgentPermission(id, allow)
    ephemeralChanged()
  })
  ipcMain.handle('douchat:export-agent-archive', async (event, agentId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const agent = await requireAgent(agentId)
    const data = exportAgentArchive(agent)
    const filename = agent.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'agent'
    const options = { defaultPath: join(app.getPath('downloads'), `${filename}.zip`), filters: [{ name: 'ZIP', extensions: ['zip'] }] }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, data)
    shell.showItemInFolder(result.filePath)
    return true
  })
  ipcMain.handle('douchat:parse-agent-archive', async (event, data: Uint8Array, root?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return parseAgentArchive(data, root)
  })
  ipcMain.handle('douchat:parse-skill-archive', async (event, data: Uint8Array) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return parseSkillArchive(data)
  })
  ipcMain.handle('douchat:update-agent', async (_event, agentId: string, input: UpdateAgentInput) => {
    const existing = await requireAgent(agentId)
    const { customModel, ...update } = input
    // Whitelist before storing; 'default' clears the override.
    if ('thinkingLevel' in update) (update as UpdateAgentInput).thinkingLevel = thinkingLevel(update.thinkingLevel) ?? 'default'
    if (customModel && (existing.localAgentId || input.localAgentId)) throw new Error("Select one execution mode.")
    const selectedBinding = customModel ? runtime.customAgentModel(customModel.providerId, customModel.model) : undefined
    input = { ...update, ...selectedBinding, followDefaultModel: customModel?.providerId === '@default' ? true : selectedBinding || input.localAgentId ? false : existing.followDefaultModel }
    const finalProvider = input.localAgentId || existing.localAgentId ? 'local' : input.provider ?? existing.provider
    if (finalProvider !== 'local' && !finalProvider.startsWith(CUSTOM_PROVIDER_PREFIX) && (existing.thinkingLevel || 'thinkingLevel' in input)) input.thinkingLevel = 'default'
    if (input.model !== undefined && (input.localAgentId || existing.localAgentId)) {
      const model = localModelId(input.model)
      if (model && !configurableLocalAgents.includes(input.localAgentId || existing.localAgentId!)) throw new Error('This local agent does not support a model override')
      input = { ...input, model: model ?? 'default' }
    }
    const localAgent = input.localAgentId ? await validateLocalAgent(input.localAgentId) : undefined
    const { localAgentName: _ignoredLocalAgentName, ...safeInput } = input
    await store.updateAgent(agentId, {
      ...safeInput,
      ...(input.localAgentId !== undefined ? { localAgentName: localAgent?.custom ? localAgent.name : undefined } : {})
    })
    // Identity and model edits take effect on the next turn, not mid-session.
    runtime.disposeAgent(agentId)
  })
  ipcMain.handle('douchat:delete-agent', async (_event, agentId: string) => {
    await requireAgent(agentId)
    runtime.disposeAgent(agentId)
    for (const provider of ['wechat', 'feishu', 'telegram'] as const) await imChannels?.disconnect(agentId, provider)
    await store.deleteAgent(agentId)
  })
  ipcMain.handle('douchat:start-direct-chat', async (_event, agentId: string) => {
    if (typeof agentId !== 'string' || !(await store.agent(agentId))) {
      throw new Error('Contact not found')
    }
    const { conversation, created } = await store.ensureDirectConversation(agentId)
    await store.markConversationRead(conversation.id)
    if (created) runtime.greetLater(conversation.id)
    return { conversationId: conversation.id }
  })
  ipcMain.handle('douchat:create-group', async (_event, input: CreateGroupInput) => {
    if (!input.agentIds?.length) throw new Error('A group needs at least one bot')
    const group = await store.createGroup(input)
    runtime.greetLater(group.id)
    return { conversationId: group.id }
  })
  ipcMain.handle('douchat:update-conversation', async (_event, conversationId: string, input: UpdateConversationInput) => {
    await requireConversation(conversationId)
    await store.updateConversation(conversationId, input)
    if (input.agentIds || input.leadAgentId) await runtime.resetConversation(conversationId)
  })
  ipcMain.handle('douchat:open-conversation-workspace', async (event, conversationId: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof conversationId !== 'string') throw new Error('Invalid workspace request')
    const conversation = await requireConversation(conversationId)
    let directory: string | undefined
    if (conversation.workspacePath) directory = resolveSavedWorkspace(conversation.workspacePath)
    else {
      if (!canAssignConversationWorkspace(conversation)) throw new Error('Workspace unavailable')
      const topicId = await store.activeTopicId(conversationId)
      const members = (await Promise.all(conversation.agentIds.map(id => store.agent(id)))).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
      const key = (id: string) => conversation.type === 'direct' ? `direct:${conversationId}:${topicId}` : groupMemberSessionId(conversationId, id, topicId)
      const existing = (await Promise.all(members.map(agent => openableWorkspace(agent, key(agent.id), conversation.type === 'group')))).flatMap(result => result ? [result] : []).sort((a, b) => b.modified - a.modified)
      directory = existing[0]?.directory ?? (await localWorkspace(members[0], key(members[0].id)))?.directory
    }
    if (!directory) throw new Error('Workspace unavailable')
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle('douchat:choose-conversation-workspace', async (event, conversationId: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof conversationId !== 'string') throw new Error('Invalid workspace request')
    const target = await requireConversation(conversationId)
    if (!canAssignConversationWorkspace(target)) throw new Error('Only chats whose members are all your own agents can use a custom workspace.')
    const options: Electron.OpenDialogOptions = { title: ui('Choose a workspace folder', '选择工作区文件夹'), buttonLabel: ui('Use this folder', '使用此文件夹'), properties: ['openDirectory', 'createDirectory'], ...(target.workspacePath ? { defaultPath: target.workspacePath } : {}) }
    if (process.platform === 'darwin') app.focus({ steal: true })
    BrowserWindow.fromWebContents(event.sender)?.focus()
    const result = await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return
    const folder = validateWorkspaceFolder(result.filePaths[0])
    const current = await store.conversation(conversationId)
    if (!current || !canAssignConversationWorkspace(current)) throw new Error('Chat members changed. Try again.')
    if (current.workspacePath !== folder) {
      await store.setConversationWorkspace(conversationId, folder)
      await runtime.workspaceChanged(conversationId)
    }
  })
  ipcMain.handle('douchat:clear-conversation-workspace', async (event, conversationId: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof conversationId !== 'string') throw new Error('Invalid workspace request')
    const target = await requireConversation(conversationId)
    if (target.workspacePath) {
      await store.setConversationWorkspace(conversationId, undefined)
      await runtime.workspaceChanged(conversationId)
    }
  })
  ipcMain.handle('douchat:open-conversation-window', async (_event, conversationId: string) => {
    await requireConversation(conversationId)
    await openChatWindow(conversationId)
  })
  ipcMain.handle('douchat:open-code-artifact', async (event, input: CodeArtifactInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid preview request')
    openCodeArtifactWindow(input)
  })
  ipcMain.handle('douchat:get-code-artifact', async (event, artifactId: string) => {
    if (typeof artifactId !== 'string') return null
    const window = codeArtifactWindows.get(artifactId)
    if (!window || window.isDestroyed() || window.webContents !== event.sender) return null
    return codeArtifacts.get(artifactId) ?? null
  })
  ipcMain.handle('douchat:test-email-connector', async (event, input: EmailConnectorInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    return emailConnectors.test(input)
  })
  ipcMain.handle('douchat:save-email-connector', async (event, input: EmailConnectorInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    await emailConnectors.save(input)
    for (const agent of await store.agents()) runtime.disposeAgent(agent.id)
  })
  ipcMain.handle('douchat:disconnect-email-connector', async (event, connectorId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof connectorId !== 'string') throw new Error('Invalid connector request')
    await emailConnectors.disconnect(connectorId)
    for (const agent of await store.agents()) runtime.disposeAgent(agent.id)
  })
  ipcMain.handle('douchat:delete-message', async (event, conversationId: string, messageId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof conversationId !== 'string' || typeof messageId !== 'string') throw new Error('Invalid message request')
    await requireConversation(conversationId)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'warning' as const, message: ui('Delete this message?', '删除这条消息？'), detail: ui('The message will be removed from your local chat history and cannot be recovered. This does not unsend it for others.', '消息将从本地聊天记录中删除，无法恢复。此操作不会撤回对方的消息。'), buttons: [ui('Cancel', '取消'), ui('Delete', '删除')], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return false
    await requireConversation(conversationId)
    await store.deleteMessage(conversationId, messageId)
    return true
  })
  ipcMain.handle('douchat:delete-conversation', async (event, conversationId: string) => {
    const target = await store.conversation(conversationId)
    if (!target) return
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'warning' as const, message: ui(`Delete the chat with “${target.name}”?`, `删除与“${target.name}”的聊天？`), detail: ui('The chat history will be deleted. This cannot be undone.', '聊天记录会被删除，此操作无法撤销。'), buttons: [ui('Cancel', '取消'), ui('Delete', '删除')], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return
    chatWindows.get(conversationId)?.close()
    await runtime.stopConversation(conversationId)
    await runtime.resetConversation(conversationId)
    await store.deleteConversation(conversationId)
  })
  ipcMain.handle('douchat:set-conversation-pinned', async (_event, conversationId: string, pinned: boolean) => {
    await requireConversation(conversationId)
    await store.setConversationPinned(conversationId, Boolean(pinned))
  })
  ipcMain.handle('douchat:mark-read', async (_event, conversationId: string) => {
    await requireConversation(conversationId)
    const conversation = await store.conversation(conversationId)
    if (conversation?.type === 'direct') runtime.greetLater(conversationId)
    await store.markConversationRead(conversationId)
  })
  ipcMain.handle('douchat:mark-all-read', async () => {
    await store.markAllConversationsRead()
  })
  ipcMain.handle('douchat:create-topic', async (_event, conversationId: string) => {
    await requireConversation(conversationId)
    const topic = await store.createTopic(conversationId)
    if (topic) runtime.greetLater(conversationId)
  })
  ipcMain.handle('douchat:rename-topic', async (_event, conversationId: string, topicId: string, title: string) => {
    await requireConversation(conversationId)
    await store.renameTopic(conversationId, topicId, title)
  })
  ipcMain.handle('douchat:delete-topic', async (_event, conversationId: string, topicId: string) => {
    await requireConversation(conversationId)
    await runtime.resetConversation(conversationId, topicId)
    await store.deleteTopic(conversationId, topicId)
  })
  ipcMain.handle('douchat:set-active-topic', async (_event, conversationId: string, topicId: string) => {
    await requireConversation(conversationId)
    await store.setActiveTopic(conversationId, topicId)
  })
  ipcMain.handle('douchat:send-message', async (
    _event,
    conversationId: string,
    text: string,
    images?: MessageImageInput[],
    files?: MessageFileInput[],
    mentions?: SelectedMention[]
  ) => {
    await requireConversation(conversationId)
    await runtime.sendMessage(conversationId, text, images, files, mentions)
  })
  ipcMain.handle('douchat:stop-conversation', async (_event, conversationId: string) => {
    await requireConversation(conversationId)
    await runtime.stopConversation(conversationId)
  })
  ipcMain.handle('douchat:clear-conversation', async (_event, conversationId: string) => {
    await requireConversation(conversationId)
    const topicId = await store.activeTopicId(conversationId)
    await store.clearConversation(conversationId, topicId)
    await runtime.resetConversation(conversationId, topicId)
  })
  ipcMain.handle('douchat:reset-conversation-context', async (_event, conversationId: string) => {
    const conversation = await requireConversation(conversationId)
    const topicId = await store.activeTopicId(conversationId)
    await runtime.resetConversation(conversationId, topicId)
    await store.resetConversationContext(conversationId, topicId)
    if (conversation.type === 'direct') runtime.greetLater(conversationId)
  })
  ipcMain.handle('douchat:create-routine', async (_event, input: CreateRoutineInput) => {
    await validateRoutineInput(input)
    await scheduler.createRoutine({
      ...input,
      name: input.name.trim(),
      prompt: input.prompt.trim()
    })
  })
  ipcMain.handle('douchat:delete-routine', async (_event, routineId: string) => {
    await scheduler.deleteRoutine(routineId)
  })
  ipcMain.handle('douchat:set-routine-enabled', async (_event, routineId: string, enabled: boolean) => {
    await scheduler.setEnabled(routineId, Boolean(enabled))
  })
  ipcMain.handle('douchat:run-routine-now', async (_event, routineId: string) => {
    await scheduler.runNow(routineId)
  })
  ipcMain.handle('douchat:start-computer', async (_event, agentId: string) => {
    await requireAgent(agentId)
    await computer.start(agentId)
  })
  ipcMain.handle('douchat:stop-computer', async (_event, agentId: string) => {
    await requireAgent(agentId)
    await computer.stop(agentId)
  })
  // Projects and coding sessions: a folder agents work in, and what they did there. Read-only views of the
  // repository (status, diff) are offered; running a command line is not something the renderer can ask for.
  ipcMain.handle('douchat:list-projects', () => store.projects())
  ipcMain.handle('douchat:choose-project', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if (process.platform === 'darwin') app.focus({ steal: true })
    BrowserWindow.fromWebContents(event.sender)?.focus()
    const result = await dialog.showOpenDialog({ title: ui('Choose a project folder', '选择项目文件夹'), buttonLabel: ui('Use this project', '使用此项目'), properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return undefined
    return coding.addProject(result.filePaths[0])
  })
  ipcMain.handle('douchat:remove-project', (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Unauthorized')
    return store.removeProject(id)
  })
  ipcMain.handle('douchat:project-git-status', (event, id: unknown, sessionId?: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || (sessionId !== undefined && typeof sessionId !== 'string')) throw new Error('Unauthorized')
    return coding.gitStatus(id, sessionId as string | undefined)
  })
  ipcMain.handle('douchat:project-git-diff', (event, id: unknown, path?: unknown, sessionId?: unknown, mode?: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || (path !== undefined && typeof path !== 'string') || (sessionId !== undefined && typeof sessionId !== 'string')
      || (mode !== undefined && mode !== 'head' && mode !== 'staged' && mode !== 'unstaged')) throw new Error('Unauthorized')
    return coding.gitDiff(id, path as string | undefined, sessionId as string | undefined, mode as GitDiffMode | undefined)
  })
  ipcMain.handle('douchat:project-pax', (event, id: unknown, command: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || (command !== 'info' && command !== 'drift')) throw new Error('Unauthorized')
    return coding.paxProject(id, command)
  })
  // The developer's own Git actions. Git stays the authority; the service refuses them while a session runs in the project.
  const isPaths = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 5000 && value.every(item => typeof item === 'string' && item.length > 0 && !item.includes('\0'))
  ipcMain.handle('douchat:project-git-stage', (event, id: unknown, paths: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || !isPaths(paths)) throw new Error('Unauthorized')
    return coding.gitStage(id, paths)
  })
  ipcMain.handle('douchat:project-git-unstage', (event, id: unknown, paths: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || !isPaths(paths)) throw new Error('Unauthorized')
    return coding.gitUnstage(id, paths)
  })
  ipcMain.handle('douchat:project-git-commit', (event, id: unknown, message: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || typeof message !== 'string') throw new Error('Unauthorized')
    return coding.gitCommit(id, message)
  })
  // What Compute says it has — read from Compute each time, never kept here. Compute's own UI is where Computers are managed.
  ipcMain.handle('douchat:compute-inventory', event => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return computeClient.inventory()
  })
  ipcMain.handle('douchat:open-compute-ui', async event => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    await shell.openExternal(`${computeClient.daemon.replace(/\/$/, '')}/ui/`)
  })
  ipcMain.handle('douchat:ci-plan', (event, projectId: unknown, tool?: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof projectId !== 'string' || (tool !== undefined && typeof tool !== 'string')) throw new Error('Unauthorized')
    return ci.plan(projectId, tool as string | undefined)
  })
  ipcMain.handle('douchat:start-ci', (event, input: { projectId?: unknown; tool?: unknown }) => {
    if (!isDouchatRenderer(event.sender) || typeof input?.projectId !== 'string' || (input.tool !== undefined && typeof input.tool !== 'string')) throw new Error('Unauthorized')
    return ci.start({ projectId: input.projectId, ...(input.tool ? { tool: input.tool as string } : {}) })
  })
  ipcMain.handle('douchat:cancel-ci', (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Unauthorized')
    return ci.cancel(id)
  })
  ipcMain.handle('douchat:list-coding-sessions', (event, projectId?: unknown) => {
    if (!isDouchatRenderer(event.sender) || (projectId !== undefined && typeof projectId !== 'string')) throw new Error('Unauthorized')
    return store.codingSessions(projectId as string | undefined)
  })
  ipcMain.handle('douchat:start-coding-session', (event, input: { projectId?: unknown; agentId?: unknown; task?: unknown; execution?: { kind?: unknown; environment?: unknown } }) => {
    if (!isDouchatRenderer(event.sender) || typeof input?.projectId !== 'string' || typeof input.agentId !== 'string' || typeof input.task !== 'string') throw new Error('Unauthorized')
    const execution = input.execution?.kind === 'compute' && typeof input.execution.environment === 'string' ? { kind: 'compute' as const, environment: input.execution.environment } : undefined
    return coding.start({ projectId: input.projectId, agentId: input.agentId, task: input.task, ...(execution ? { execution } : {}) })
  })
  ipcMain.handle('douchat:continue-coding-session', (event, id: unknown, text?: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || (text !== undefined && typeof text !== 'string')) throw new Error('Unauthorized')
    return coding.continue(id, text as string | undefined)
  })
  ipcMain.handle('douchat:run-coding-checks', (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Unauthorized')
    return coding.runChecks(id)
  })
  // The renderer proposes a command line for a project's check; running it is command execution on this computer,
  // so the owner confirms it here, in the main process, and it is stored as an argument vector.
  ipcMain.handle('douchat:set-project-test-command', async (event, id: unknown, commandLine: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string' || typeof commandLine !== 'string') throw new Error('Unauthorized')
    const project = await store.project(id)
    if (!project) throw new Error('Project not found')
    const argv = parseCommandLine(commandLine)
    if (!argv.length) return store.setProjectTestCommand(id, undefined)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'question' as const, message: ui('Run this command as the check for this project?', '将此命令设为该项目的检查命令？'),
      detail: `${formatCommandLine(argv)}\n\n${ui('Program', '程序')}: ${argv[0]}\n${argv.slice(1).map((part, index) => `${ui('Argument', '参数')} ${index + 1}: ${JSON.stringify(part)}`).join('\n')}\n\n${ui('It will run on this computer in', '点击“运行检查”时将在此电脑上运行，目录：')} ${project.path}`,
      buttons: [ui('Cancel', '取消'), ui('Use this command', '使用此命令')], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return project
    return store.setProjectTestCommand(id, argv)
  })
  ipcMain.handle('douchat:cancel-coding-session', (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Unauthorized')
    return coding.cancel(id)
  })
  ipcMain.handle('douchat:show-computer', async (_event, agentId: string) => {
    await requireAgent(agentId)
    await computer.show(agentId)
  })

  // Windows open on the local desktop immediately. Nothing waits on a network,
  // an account, or a provider: models are configured when the person wants them.
  await reloadCustomModels()
  try { await imChannels.activate() } catch { console.warn('[foundry] IM credentials could not be loaded') }
  // Update checks contact the release feed, so they run only when asked for.
  scheduler.start()
  powerMonitor.on('resume', () => { scheduler.checkNow() })
  app.on('activate', () => focusMainWindow())
  createWindow()
  // Group tasks interrupted by the last shutdown continue in the background; their progress arrives through FeltDB.
  void runtime.recoverGroupWorkflows().catch(error => diagnostics.write('recovery.failed', error instanceof Error ? error.stack || error.message : String(error)))
}).catch(error => {
  diagnostics.write('desktop.boot-failed', error instanceof Error ? error.stack || error.message : String(error))
  dialog.showErrorBox('Foundry', String(error instanceof Error ? error.message : error))
  quitting = true
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Shutdown is ordered so that nothing durable is lost: stop accepting work,
 * cancel what is running and let it settle (each turn writes its final state),
 * then wait for FeltDB to finish its writes and close it.
 */
let shutdown: Promise<void> | undefined
app.on('before-quit', (event) => {
  if (shutdown) {
    // A second quit request arrives once shutdown has finished.
    if (shutdownComplete) return
    event.preventDefault()
    return
  }
  quitting = true
  if (!runtime && !desktop) return
  event.preventDefault()
  shutdown = (async () => {
    updater?.stopAutomaticChecks()
    cancelLocalModelQueries()
    runtime?.stopAccepting()
    imChannels?.stop()
    // Remote clients stop being served first; a session they started is cancelled below like any other.
    await appPort?.close().catch(() => undefined)
    await appPortServices?.apiKeys.close().catch(() => undefined)
    // CI workloads first: each is stopped and its ephemeral Computer released before Foundry goes.
    await ci?.shutdown().catch(() => undefined)
    // Coding sessions next, so each records how it ended before FeltDB closes.
    await coding?.cancelAll().catch(() => undefined)
    runtime?.cancelAll()
    if (localWorkBlocker !== undefined) { powerSaveBlocker.stop(localWorkBlocker); localWorkBlocker = undefined }
    computer?.dispose()
    try {
      await scheduler?.dispose()
      await coding?.idle()
      await runtime?.games.settled()
      await runtime?.idle()
      await projection?.stop()
    } catch (error) {
      diagnostics.write('shutdown.failed', error instanceof Error ? error.stack || error.message : String(error))
    }
    // FeltDB writes are awaited, then its journal is folded into a snapshot and its lock released.
    try { await stopDesktop(desktop) }
    catch (error) { diagnostics.write('shutdown.close-failed', error instanceof Error ? error.stack || error.message : String(error)) }
  })().finally(() => { shutdownComplete = true; app.quit() })
})
let shutdownComplete = false
