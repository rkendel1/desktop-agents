import { createApplication } from '@appport/core'
import { permissionAuthorizer } from '@appport/authorization'
import { createServer, type Authenticate, type AppPortServer } from '@appport/server'
import { serve, type RunningServer } from '@appport/server/node'
import type { CodingApi } from '../coding/api'
import type { AppPortServices } from '@appport/services'
import { APPLICATION, codingCapabilities, codingEvents, type RemoteLookup } from './contract'
import { apiKeyAuthenticator, ensureClientApiKey } from './services'

/**
 * Wire the coding capability to AppPort.
 *
 * The application holds no state of its own: its handlers call the CodingApi, and the CodingApi
 * reads FeltDB, Git and the runtime. Live notices from the coding service are forwarded to
 * AppPort's event bus, which is at-most-once and keeps nothing.
 */
export function createDouchatAppPort(api: CodingApi, authenticate?: Authenticate, remote?: RemoteLookup): { server: AppPortServer; close(): void } {
  const application = createApplication({
    application: APPLICATION,
    capabilities: codingCapabilities(api, remote),
    events: codingEvents(),
    authorizer: permissionAuthorizer(),
    mode: 'production'
  })
  const unsubscribe = api.subscribe(notification => { void application.emit({ name: notification.name, payload: { ...notification } }).catch(() => undefined) })
  const server = createServer({ application, ...(authenticate ? { authenticate } : {}) })
  return { server, close: () => { unsubscribe(); void server.close() } }
}

export interface AppPortHostOptions {
  api: CodingApi
  /** AppPort Services over Douchat's flow: they identify callers by API key. */
  services: AppPortServices
  /** The project → remote lookup backed by the @appport/github capability. */
  remote?: RemoteLookup
  /** Folder for the client key file (the app's user-data directory). */
  directory: string
  /** 0 picks a free port. */
  port?: number
}

export interface AppPortHost {
  url: string
  port: number
  /** Where the owner finds the API key a client must present as `Authorization: Bearer …`. */
  keyFile: string
  close(): Promise<void>
}

/** Serve the coding capability on this computer's loopback interface. Off unless the owner turns it on. */
export async function startAppPortHost(options: AppPortHostOptions): Promise<AppPortHost> {
  const { file } = await ensureClientApiKey(options.services, options.directory)
  const app = createDouchatAppPort(options.api, apiKeyAuthenticator(options.services), options.remote)
  // Loopback only, and no browser origin is accepted: a web page cannot speak to this port.
  const running: RunningServer = await serve({ server: app.server, host: '127.0.0.1', port: options.port ?? 0, websocket: true, allowedOrigins: [] })
  return { url: running.url, port: running.port, keyFile: file, close: async () => { app.close(); await running.close() } }
}
