import { Bot, Laptop, PlugZap, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { t } from '../preferences'
import type { LocalAgent } from '../../../shared/types'
import { AgentDialogSurface as NativeDialog } from './AgentDialogSurface'

/**
 * The first thing on a fresh install. It is optional: the desktop behind it is
 * already open and working, and nothing here asks for an account, a network
 * connection, or a configured model.
 */
export function WelcomeDialog({ localAgents, scanning, onCreateAgent, onDismiss }: {
  localAgents: LocalAgent[]
  scanning: boolean
  onCreateAgent: (localAgentId?: string) => void
  onDismiss: () => void
}): ReactElement {
  const detected = localAgents.filter((agent) => agent.installed)
  const claude = detected.find((agent) => agent.id === 'claude')
  return <NativeDialog className="modal-backdrop welcome-backdrop" onClose={onDismiss}>
    <section className="agent-modal welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="modal-heading">
        <h2 id="welcome-title">{t('Welcome to your local agent desktop')}</h2>
        <button type="button" className="icon-button" onClick={onDismiss} aria-label={t('Close')}><X size={18} /></button>
      </div>
      <p className="welcome-lede">{t('Everything here is stored on this computer. There is no account to create and nothing to sign in to. Agents you add keep their own credentials.')}</p>
      <div className="welcome-detected" aria-live="polite">
        <strong>{scanning ? t('Looking for agents on this computer…') : detected.length ? t('Found on this computer') : t('No agents detected yet')}</strong>
        {detected.length > 0 && <ul>{detected.map((agent) => <li key={agent.id}><Laptop size={14} /> {agent.name}{agent.version ? <small> · {agent.version}</small> : null}</li>)}</ul>}
      </div>
      <div className="welcome-actions">
        {claude && <button type="button" className="primary-button" onClick={() => onCreateAgent(claude.id)}><Bot size={16} /> {t('Start with Claude Code')}</button>}
        <button type="button" className={claude ? 'secondary-button' : 'primary-button'} onClick={() => onCreateAgent()}><PlugZap size={16} /> {t('Choose or create an agent')}</button>
        <button type="button" className="secondary-button" onClick={onDismiss}>{t('Look around first')}</button>
      </div>
    </section>
  </NativeDialog>
}
