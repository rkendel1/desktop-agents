import { t, tr } from '../preferences'
import type { CustomModelConfig } from '../../../shared/customModels'

/** Pick one of the model providers configured on this computer. */
export function CustomModelSelection({ config, providerId, model, disabled, onChange }: {
  config: CustomModelConfig
  providerId: string
  model: string
  disabled?: boolean
  onChange: (providerId: string, model: string) => void
}) {
  const [defaultProviderId, ...parts] = config.defaultModel.split('/')
  const defaultAvailable = Boolean(config.providers.find(item => item.id === defaultProviderId)?.models.includes(parts.join('/')))
  const options = config.providers.flatMap(provider => provider.models.map(id => ({ providerId: provider.id, model: id, label: provider.id + '/' + id })))
  options.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true }))
  const isDefault = providerId === '@default'
  const selected = isDefault ? 'default' : JSON.stringify([providerId, model])
  const available = isDefault || options.some(item => item.providerId === providerId && item.model === model)
  return <div className="custom-model-selection">
    <label className="field-row"><span>{t('Model')}</span>
      <select aria-label={t('Custom model')} value={selected} disabled={disabled} onChange={event => {
        if (event.target.value === 'default') onChange('@default', 'default')
        else {
          const option = options.find(item => JSON.stringify([item.providerId, item.model]) === event.target.value)
          if (option) onChange(option.providerId, option.model)
        }
      }}>
        <option value="default" disabled={!defaultAvailable}>{t('Default model')}</option>
        {!available && <option value={selected} disabled>{tr('{name} (unavailable)', { name: model || t('Choose a model') })}</option>}
        {options.map(item => <option key={JSON.stringify([item.providerId, item.model])} value={JSON.stringify([item.providerId, item.model])}>{item.label}</option>)}
      </select>
    </label>
  </div>
}
