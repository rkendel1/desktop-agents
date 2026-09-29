import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { access, mkdir, readdir, realpath, rename, stat, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BrowserWindow } from 'electron'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ComputerSession } from '../shared/types'

interface PageElement {
  ref: string
  role: string
  label: string
  value: string
  disabled: boolean
}

interface PageObservation {
  url: string
  title: string
  text: string
  elements: PageElement[]
}

interface ManagedComputer {
  snapshot: ComputerSession
  browser?: BrowserWindow
  captureTimer?: NodeJS.Timeout
  capturing: boolean
  lastFrame?: Buffer
}

export type RequestFolderAccess = (path: string, operation: string, signal?: AbortSignal) => Promise<void>
class FolderAccessRequired extends Error {}

export interface ComputerProvider {
  snapshots(): ComputerSession[]
  start(agentId: string): Promise<ComputerSession>
  stop(agentId: string): Promise<void>
  show(agentId: string): Promise<void>
  createTools(agentId: string, extraRoots?: () => string[] | Promise<string[]>, requestAccess?: RequestFolderAccess): AgentTool[]
  dispose(): void
}

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

function safeUrl(input: string): string {
  const candidate = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`
  const parsed = new URL(candidate)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are supported')
  return parsed.toString()
}

function shortDetail(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function localFileError(error: unknown, target: string): Error {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(
      `Foundry needs permission to access ${basename(target) || target}. `
      + 'Allow Foundry in System Settings → Privacy & Security → Files and Folders, then try again. '
      + `(${code})`
    )
  }
  return error instanceof Error ? error : new Error(shortDetail(error))
}

export class LocalComputerProvider implements ComputerProvider {
  private disposed = false
  private notifyChange(): void {
    if (!this.disposed) this.onChange()
  }

  private readonly computers = new Map<string, ManagedComputer>()
  private readonly allowedRoots: string[]
  private readonly allowedRealRoots: string[]

  constructor(
    private readonly onChange: () => void,
    allowedRoots: string[],
    private readonly openPath: (path: string) => Promise<string>
  ) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root))
    this.allowedRealRoots = allowedRoots.map((root) => {
      try { return realpathSync(root) } catch { return resolve(root) }
    })
  }

  snapshots(): ComputerSession[] {
    return [...this.computers.values()].map((computer) => ({ ...computer.snapshot }))
  }

  async start(agentId: string): Promise<ComputerSession> {
    if (this.disposed) throw new Error('Computer provider is closed')
    const computer = this.getOrCreate(agentId)
    if (computer.browser && !computer.browser.isDestroyed()) return { ...computer.snapshot }

    computer.snapshot.status = 'starting'
    computer.snapshot.error = undefined
    computer.snapshot.lastAction = 'Starting private browser'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()

    const browser = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 520,
      show: false,
      title: 'Foundry computer',
      backgroundColor: '#F7F7F5',
      autoHideMenuBar: true,
      webPreferences: {
        partition: `persist:douchat-agent-${agentId.replace(/[^a-z0-9-]/gi, '-')}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    computer.browser = browser

    browser.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    browser.webContents.setWindowOpenHandler(({ url }) => {
      try {
        void browser.loadURL(safeUrl(url))
      } catch {
        // Ignore unsupported popup schemes.
      }
      return { action: 'deny' }
    })
    browser.webContents.on('did-start-loading', () => this.setActivity(agentId, 'Loading page', 'working'))
    browser.webContents.on('did-stop-loading', () => {
      this.syncPageMetadata(agentId)
      void this.capture(agentId, true)
    })
    browser.webContents.on('did-navigate-in-page', () => {
      this.syncPageMetadata(agentId)
      void this.capture(agentId, true)
    })
    browser.webContents.on('page-title-updated', () => this.syncPageMetadata(agentId))
    browser.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.setError(agentId, errorDescription)
    })
    browser.on('closed', () => {
      if (computer.captureTimer) clearInterval(computer.captureTimer)
      computer.browser = undefined
      computer.captureTimer = undefined
      computer.snapshot.status = 'stopped'
      computer.snapshot.lastAction = 'Computer stopped'
      computer.snapshot.updatedAt = Date.now()
      this.notifyChange()
    })

    await browser.loadURL('about:blank')
    if (this.disposed) return { ...computer.snapshot }
    computer.snapshot.status = 'ready'
    computer.snapshot.lastAction = 'Ready for a task'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
    await this.capture(agentId, true)

    if (this.disposed) return { ...computer.snapshot }
    computer.captureTimer = setInterval(() => void this.capture(agentId), 1_500)
    return { ...computer.snapshot }
  }

  async stop(agentId: string): Promise<void> {
    const computer = this.computers.get(agentId)
    if (!computer) return
    if (computer.captureTimer) clearInterval(computer.captureTimer)
    computer.captureTimer = undefined
    if (computer.browser && !computer.browser.isDestroyed()) computer.browser.close()
    computer.browser = undefined
    computer.snapshot.status = 'stopped'
    computer.snapshot.lastAction = 'Computer stopped'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
  }

  async show(agentId: string): Promise<void> {
    const computer = this.getOrCreate(agentId)
    if (!computer.browser || computer.browser.isDestroyed()) await this.start(agentId)
    computer.browser?.show()
    computer.browser?.focus()
    this.setActivity(agentId, 'Interactive window opened', 'ready')
  }

  /** Open a renderer-selected history reference after applying the same path
   *  and symlink checks as the agent tool. */
  async openLocalFile(input: string, extraRoots: () => string[] | Promise<string[]> = () => []): Promise<{ path: string; size: number }> {
    const { target, size } = await this.existingAllowedFile(input, await extraRoots())
    this.resolveAllowedPath(target, await extraRoots())
    const error = await this.openPath(target)
    if (error) throw new Error(`Could not open ${basename(target)}: ${error}`)
    return { path: target, size }
  }

  async navigate(agentId: string, input: string): Promise<PageObservation> {
    const url = safeUrl(input)
    return this.runAction(agentId, `Opening ${new URL(url).hostname}`, async (browser) => {
      await browser.loadURL(url)
      return this.observe(agentId)
    })
  }

  async observe(agentId: string): Promise<PageObservation> {
    const browser = await this.ensureBrowser(agentId)
    const observation = await browser.webContents.executeJavaScript(`(() => {
      const candidates = Array.from(document.querySelectorAll(
        'a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], [tabindex]'
      ));
      const elements = candidates.filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).slice(0, 120).map((element, index) => {
        const ref = 'e' + index;
        element.setAttribute('data-douchat-ref', ref);
        const htmlElement = element;
        const role = element.getAttribute('role') || element.tagName.toLowerCase();
        const label = element.getAttribute('aria-label') || element.getAttribute('title') ||
          element.getAttribute('placeholder') || element.innerText || element.getAttribute('alt') || '';
        const value = 'value' in htmlElement ? String(htmlElement.value || '') : '';
        return { ref, role, label: String(label).trim().slice(0, 180), value: value.slice(0, 180), disabled: Boolean(htmlElement.disabled) };
      });
      return {
        url: location.href,
        title: document.title,
        text: String(document.body?.innerText || '').trim().slice(0, 7000),
        elements
      };
    })()`)
    this.syncPageMetadata(agentId)
    await this.capture(agentId, true)
    return observation as PageObservation
  }

  async click(agentId: string, ref: string): Promise<PageObservation> {
    if (!/^e\d+$/.test(ref)) throw new Error('Invalid element reference. Take a new snapshot and use a listed ref.')
    return this.runAction(agentId, `Clicking ${ref}`, async (browser) => {
      const clicked = await browser.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('[data-douchat-ref="${ref}"]');
        if (!element) return false;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return true;
      })()`)
      if (!clicked) throw new Error(`Element ${ref} is no longer available. Take a new snapshot.`)
      await pause(500)
      return this.observe(agentId)
    })
  }

  async type(agentId: string, ref: string, text: string, submit: boolean): Promise<PageObservation> {
    if (!/^e\d+$/.test(ref)) throw new Error('Invalid element reference. Take a new snapshot and use a listed ref.')
    return this.runAction(agentId, `Typing into ${ref}`, async (browser) => {
      const completed = await browser.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('[data-douchat-ref="${ref}"]');
        if (!element) return false;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.focus();
        const value = ${JSON.stringify(text)};
        if (element.isContentEditable) {
          element.textContent = value;
        } else if ('value' in element) {
          const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          setter ? setter.call(element, value) : element.value = value;
        } else return false;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      if (!completed) throw new Error(`Element ${ref} cannot accept text. Take a new snapshot.`)
      if (submit) {
        browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      }
      await pause(submit ? 650 : 250)
      return this.observe(agentId)
    })
  }

  async scroll(agentId: string, direction: 'up' | 'down', amount: number): Promise<PageObservation> {
    return this.runAction(agentId, `Scrolling ${direction}`, async (browser) => {
      const distance = Math.min(1800, Math.max(120, Math.round(amount))) * (direction === 'up' ? -1 : 1)
      await browser.webContents.executeJavaScript(`window.scrollBy({ top: ${distance}, behavior: 'instant' })`)
      await pause(220)
      return this.observe(agentId)
    })
  }

  createTools(agentId: string, extraRoots: () => string[] | Promise<string[]> = () => [], requestAccess?: RequestFolderAccess): AgentTool[] {
    const allowedPath = async (path: string) => this.resolveAllowedPath(path, await extraRoots())
    const preparePath = async (path: string, operation: string, signal?: AbortSignal): Promise<string> => {
      try { return await allowedPath(path) } catch (error) {
        if (!(error instanceof FolderAccessRequired) || !requestAccess) throw error
        await requestAccess(path, operation, signal)
        signal?.throwIfAborted()
        return allowedPath(path)
      }
    }
    const openParameters = Type.Object({ url: Type.String({ description: 'The http(s) URL to open' }) })
    const snapshotParameters = Type.Object({})
    const clickParameters = Type.Object({ ref: Type.String({ description: 'Element ref from computer_snapshot' }) })
    const typeParameters = Type.Object({
      ref: Type.String({ description: 'Element ref from computer_snapshot' }),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean({ description: 'Press Enter after typing' }))
    })
    const scrollParameters = Type.Object({
      direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
      amount: Type.Optional(Type.Number({ description: 'Pixels to scroll, defaults to 650' }))
    })
    const listFilesParameters = Type.Object({
      path: Type.Optional(Type.String({
        description: 'Omit this field to list Downloads first. For deeper browsing, use only an absolute path returned by a previous computer_list_files call. Never guess a home directory, use ~, or pass a relative path.'
      }))
    })
    const openFileParameters = Type.Object({
      path: Type.String({ description: 'The absolute path of an existing file inside Downloads, Desktop, Documents, or folders authorized for this conversation' })
    })
    const makeDirectoryParameters = Type.Object({
      path: Type.String({ description: 'The absolute directory path to create inside Downloads, Desktop, Documents, or folders authorized for this conversation' })
    })
    const moveFileParameters = Type.Object({
      source: Type.String({ description: 'Absolute source path inside an allowed folder' }),
      destination: Type.String({ description: 'Absolute destination directory or new full path inside an allowed folder' })
    })

    const result = (observation: PageObservation) => {
      const computer = this.computers.get(agentId)?.snapshot
      const elements = observation.elements
        .map((element) => `[${element.ref}] ${element.role} “${element.label || element.value || 'unlabelled'}”${element.disabled ? ' disabled' : ''}`)
        .join('\n')
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        {
          type: 'text',
          text: `Page: ${observation.title || 'Untitled'}\nURL: ${observation.url}\n\nVisible text:\n${observation.text || '(empty)'}\n\nInteractive elements:\n${elements || '(none)'}`
        }
      ]
      if (computer?.previewDataUrl) {
        content.push({
          type: 'image',
          data: computer.previewDataUrl.slice(computer.previewDataUrl.indexOf(',') + 1),
          mimeType: 'image/jpeg'
        })
      }
      return { content, details: { sessionId: computer?.id, url: observation.url, title: observation.title } }
    }

    const openTool: AgentTool<typeof openParameters> = {
      name: 'computer_open',
      label: 'Open page',
      description: 'Open a web page in your private computer, then inspect its visible content and controls.',
      parameters: openParameters,
      execute: async (_id, params) => result(await this.navigate(agentId, params.url))
    }
    const snapshotTool: AgentTool<typeof snapshotParameters> = {
      name: 'computer_snapshot',
      label: 'Inspect computer',
      description: 'Inspect the current page. Returns visible text, a screenshot, and element refs for interaction.',
      parameters: snapshotParameters,
      execute: async () => result(await this.observe(agentId))
    }
    const clickTool: AgentTool<typeof clickParameters> = {
      name: 'computer_click',
      label: 'Click control',
      description: 'Click an element using a ref from the latest computer snapshot.',
      parameters: clickParameters,
      execute: async (_id, params) => result(await this.click(agentId, params.ref))
    }
    const typeTool: AgentTool<typeof typeParameters> = {
      name: 'computer_type',
      label: 'Type text',
      description: 'Replace the text in an input using a ref from the latest snapshot.',
      parameters: typeParameters,
      execute: async (_id, params) => result(await this.type(agentId, params.ref, params.text, params.submit ?? false))
    }
    const scrollTool: AgentTool<typeof scrollParameters> = {
      name: 'computer_scroll',
      label: 'Scroll page',
      description: 'Scroll the current page and return a fresh observation.',
      parameters: scrollParameters,
      execute: async (_id, params) => result(await this.scroll(agentId, params.direction, params.amount ?? 650))
    }
    const listFilesTool: AgentTool<typeof listFilesParameters> = {
      name: 'computer_list_files',
      label: 'List local files',
      description: 'List files and folders in Downloads, Desktop, Documents, or folders authorized for this conversation only after the human explicitly asks to inspect local files. Otherwise ask for permission first. Omit path to inspect Downloads and discover allowedFolders (including this conversation’s workspace), then reuse returned absolute paths for subfolders. Never invent a local path. This tool only reads metadata.',
      parameters: listFilesParameters,
      execute: async (_id, params, signal) => {
        const target = await preparePath(params.path ?? this.allowedRoots[0], 'computer_list_files', signal)
        this.setFileActivity(agentId, `Reading ${basename(target) || target}`, true)
        try {
          const entries = await readdir(target, { withFileTypes: true })
          const details = await Promise.all(entries.slice(0, 300).map(async (entry) => {
            const entryPath = join(target, entry.name)
            const metadata = await lstat(entryPath)
            return {
              name: entry.name,
              path: entryPath,
              kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
              size: metadata.size,
              modifiedAt: metadata.mtime.toISOString()
            }
          }))
          await allowedPath(target)
          this.setFileActivity(agentId, `Listed ${details.length} items`, false)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ path: target, allowedFolders: [...this.allowedRoots, ...await extraRoots()], entries: details }, null, 2) }],
            details: { path: target, count: details.length, truncated: entries.length > details.length }
          }
        } catch (error) {
          this.setFileActivity(agentId, 'Could not read folder', false)
          throw localFileError(error, target)
        }
      }
    }
    const openFileTool: AgentTool<typeof openFileParameters> = {
      name: 'computer_open_file',
      label: 'Open local file',
      description: 'Open an existing file from Downloads, Desktop, Documents, or folders authorized for this conversation in the operating system’s default app. Use this to play a video or audio file, view a document, or reveal other local content only when the human explicitly asks to open it.',
      parameters: openFileParameters,
      execute: async (_id, params, signal) => {
        await preparePath(params.path, 'computer_open_file', signal)
        this.setFileActivity(agentId, `Opening ${basename(params.path)}`, true)
        try {
          const { path: target, size } = await this.openLocalFile(params.path, extraRoots)
          this.setFileActivity(agentId, `Opened ${basename(target)}`, false)
          return {
            content: [{ type: 'text' as const, text: `Opened in the default desktop app: ${target}` }],
            details: { path: target, size }
          }
        } catch (error) {
          const failure = localFileError(error, params.path)
          const message = failure.message
          this.setError(agentId, message)
          throw failure
        }
      }
    }
    const makeDirectoryTool: AgentTool<typeof makeDirectoryParameters> = {
      name: 'computer_make_directory',
      label: 'Create folder',
      description: 'Create a folder inside Downloads, Desktop, Documents, or folders authorized for this conversation. Existing folders are left unchanged.',
      parameters: makeDirectoryParameters,
      execute: async (_id, params, signal) => {
        const target = await preparePath(params.path, 'computer_make_directory', signal)
        this.setFileActivity(agentId, `Creating ${basename(target)}`, true)
        await mkdir(target, { recursive: true })
        this.setFileActivity(agentId, `Created ${basename(target)}`, false)
        return {
          content: [{ type: 'text' as const, text: `Directory ready: ${target}` }],
          details: { path: target }
        }
      }
    }
    const moveFileTool: AgentTool<typeof moveFileParameters> = {
      name: 'computer_move_file',
      label: 'Move local file',
      description: 'Move or rename one file or folder inside Downloads, Desktop, Documents, or folders authorized for this conversation. Never overwrites an existing item and never deletes.',
      parameters: moveFileParameters,
      execute: async (_id, params, signal) => {
        const source = await preparePath(params.source, 'computer_move_file', signal)
        const requestedDestination = await preparePath(params.destination, 'computer_move_file', signal)
        const destinationMetadata = await stat(requestedDestination).catch((error: unknown) => {
          if (isMissingFile(error)) return undefined
          throw error
        })
        const destination = destinationMetadata?.isDirectory()
          ? join(requestedDestination, basename(source))
          : requestedDestination
        await allowedPath(destination)
        try {
          await access(destination)
          throw new Error(`Destination already exists: ${destination}`)
        } catch (error) {
          if (!isMissingFile(error)) throw error
        }
        this.setFileActivity(agentId, `Moving ${basename(source)}`, true)
        await allowedPath(source); await allowedPath(destination)
        await rename(source, destination)
        this.setFileActivity(agentId, `Moved ${basename(source)}`, false)
        return {
          content: [{ type: 'text' as const, text: `Moved without overwriting:\n${source}\n→ ${destination}` }],
          details: { source, destination }
        }
      }
    }
    return [
      openTool,
      snapshotTool,
      clickTool,
      typeTool,
      scrollTool,
      listFilesTool,
      openFileTool,
      makeDirectoryTool,
      moveFileTool
    ]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const agentId of this.computers.keys()) void this.stop(agentId)
  }

  private getOrCreate(agentId: string): ManagedComputer {
    const existing = this.computers.get(agentId)
    if (existing) return existing
    const computer: ManagedComputer = {
      snapshot: {
        id: randomUUID(),
        agentId,
        status: 'stopped',
        url: '',
        title: '',
        lastAction: 'Computer is off',
        updatedAt: Date.now()
      },
      capturing: false
    }
    this.computers.set(agentId, computer)
    return computer
  }

  private async ensureBrowser(agentId: string): Promise<BrowserWindow> {
    const computer = this.getOrCreate(agentId)
    if (!computer.browser || computer.browser.isDestroyed()) await this.start(agentId)
    if (!computer.browser) throw new Error('Computer could not be started')
    return computer.browser
  }

  private async runAction<T>(
    agentId: string,
    label: string,
    action: (browser: BrowserWindow) => Promise<T>
  ): Promise<T> {
    const browser = await this.ensureBrowser(agentId)
    this.setActivity(agentId, label, 'working')
    try {
      const output = await action(browser)
      this.setActivity(agentId, label, 'ready')
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : shortDetail(error)
      this.setError(agentId, message)
      throw error
    }
  }

  private syncPageMetadata(agentId: string): void {
    const computer = this.computers.get(agentId)
    if (!computer?.browser || computer.browser.isDestroyed()) return
    computer.snapshot.url = computer.browser.webContents.getURL() === 'about:blank' ? '' : computer.browser.webContents.getURL()
    computer.snapshot.title = computer.browser.webContents.getTitle()
    if (computer.snapshot.status !== 'working') computer.snapshot.status = 'ready'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
  }

  private setActivity(agentId: string, label: string, status: ComputerSession['status']): void {
    const computer = this.getOrCreate(agentId)
    computer.snapshot.lastAction = label
    computer.snapshot.status = status
    computer.snapshot.error = undefined
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
  }

  private setError(agentId: string, message: string): void {
    const computer = this.getOrCreate(agentId)
    computer.snapshot.status = 'error'
    computer.snapshot.error = message
    computer.snapshot.lastAction = 'Action failed'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
  }

  private setFileActivity(agentId: string, label: string, working: boolean): void {
    const computer = this.getOrCreate(agentId)
    computer.snapshot.lastAction = label
    computer.snapshot.status = computer.browser && !computer.browser.isDestroyed()
      ? (working ? 'working' : 'ready')
      : 'stopped'
    computer.snapshot.updatedAt = Date.now()
    this.notifyChange()
  }

  private resolveAllowedPath(input: string, extraRoots: string[] = []): string {
    const realRoots = [...this.allowedRealRoots, ...extraRoots.map(root => realpathSync(root))]
    const roots = [...this.allowedRoots, ...extraRoots, ...realRoots]
    if (!input?.trim()) throw new Error('A path is required')
    if (!isAbsolute(input)) throw new Error('Use an absolute path inside Downloads, Desktop, Documents, or folders authorized for this conversation')
    const target = resolve(input)
    if (!this.isWithinRoots(target, roots)) {
      throw new FolderAccessRequired(`Path is outside the allowed folders: ${[...this.allowedRoots, ...extraRoots].join(', ')}`)
    }
    // Resolve the nearest existing parent as well, including for mkdir/move.
    // A link inside an allowed folder must not grant access outside it.
    let parent = target
    for (;;) {
      try {
        const canonical = realpathSync(parent)
        if (!this.isWithinRoots(canonical, realRoots)) throw new FolderAccessRequired('Path is outside the allowed folders.')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
        parent = dirname(parent)
      }
    }
    return target
  }

  private async existingAllowedFile(input: string, extraRoots: string[] = []): Promise<{ target: string; size: number }> {
    const requestedPath = this.resolveAllowedPath(input, extraRoots)
    // Follow the path before opening so a symlink inside an allowed root cannot
    // escape into another part of the machine.
    const target = await realpath(requestedPath)
    if (!this.isWithinRoots(target, [...this.allowedRealRoots, ...extraRoots.map(root => realpathSync(root))])) {
      throw new FolderAccessRequired(`Path is outside the allowed folders: ${[...this.allowedRoots, ...extraRoots].join(', ')}`)
    }
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error('Choose a file, not a folder')
    return { target, size: metadata.size }
  }

  private isWithinRoots(target: string, roots: string[]): boolean {
    return roots.some((root) => {
      const difference = relative(resolve(root), target)
      return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
    })
  }

  private async capture(agentId: string, force = false): Promise<void> {
    const computer = this.computers.get(agentId)
    if (!computer?.browser || computer.browser.isDestroyed() || computer.capturing) return
    computer.capturing = true
    try {
      const image = await computer.browser.webContents.capturePage(undefined, {
        stayHidden: !computer.browser.isVisible(),
        stayAwake: false
      })
      const jpeg = image.resize({ width: 560, quality: 'good' }).toJPEG(68)
      if (!force && computer.lastFrame?.equals(jpeg)) return
      computer.lastFrame = jpeg
      computer.snapshot.previewDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      computer.snapshot.updatedAt = Date.now()
      this.notifyChange()
    } catch {
      // The page may be between navigations; the next capture will retry.
    } finally {
      computer.capturing = false
    }
  }
}
