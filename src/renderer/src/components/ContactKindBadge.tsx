import { Monitor, UserRound } from 'lucide-react'
import { t } from '../preferences'

export function ContactKindBadge({ human, local }: { human?: boolean; local?: boolean }) {
  if (!human && !local) return null
  const label = human ? t('You') : t('Local')
  const Icon = human ? UserRound : Monitor
  return <span className="contact-kind-badge" title={label} aria-label={label}><Icon size={12} strokeWidth={1.6} /></span>
}
