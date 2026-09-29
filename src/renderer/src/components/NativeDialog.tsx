import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { reportDiagnostic } from '../diagnostics'

const openDialogs: symbol[] = []

interface Props extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void
  width?: number
  height?: number
  layoutKey?: string
}

/** A native BrowserWindow, with React state/callbacks owned by the opening workspace. */
export function NativeDialog({ children, onClose, width: _width, height: _height, layoutKey, className = '', ...props }: Props): ReactElement | null {
  const width = _width ?? 560
  const height = 400
  const name = useRef(`douchat-dialog-${crypto.randomUUID()}`).current
  const close = useRef(onClose)
  close.current = onClose
  const [host, setHost] = useState<HTMLElement>()
  const [failed, setFailed] = useState(false)
  useLayoutEffect(() => {
    const child = window.open('about:blank', name, `width=${width},height=${height}`)
    if (!child) {
      reportDiagnostic('native-dialog.open-failed')
      setFailed(true)
      return
    }
    const doc = child.document
    doc.title = ''
    const base = doc.createElement('base')
    base.href = document.baseURI
    doc.head.appendChild(base)
    const syncTheme = () => {
      for (const attribute of Array.from(document.documentElement.attributes)) {
        if (attribute.name !== 'class') doc.documentElement.setAttribute(attribute.name, attribute.value)
      }
      doc.documentElement.className = `${document.documentElement.className} native-dialog-window`
    }
    syncTheme()
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true })
    const styleCopies = new Map<Element, HTMLElement>()
    const syncStyles = () => {
      const sources = new Set(document.querySelectorAll('style, link[rel="stylesheet"]'))
      // Keep existing stylesheet nodes attached. Replacing them all on a tab's
      // lazy CSS load briefly removes every layout rule from the child window.
      for (const source of sources) {
        let copy = styleCopies.get(source)
        if (!copy) {
          copy = source.cloneNode(true) as HTMLElement
          copy.setAttribute('data-dialog-style', '')
          styleCopies.set(source, copy)
          doc.head.appendChild(copy)
        } else if (source.tagName === 'STYLE' && copy.textContent !== source.textContent) {
          copy.textContent = source.textContent
        }
      }
      for (const [source, copy] of styleCopies) {
        if (!sources.has(source)) { copy.remove(); styleCopies.delete(source) }
      }
    }
    syncStyles()
    const styleObserver = new MutationObserver(syncStyles)
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    const target = doc.createElement('div')
    target.className = 'messenger native-dialog-host'
    doc.body.appendChild(target)
    const token = Symbol('native-dialog')
    openDialogs.push(token)
    document.documentElement.classList.add('has-native-dialog')
    const releaseBackdrop = () => {
      const index = openDialogs.indexOf(token)
      if (index >= 0) openDialogs.splice(index, 1)
      if (!openDialogs.length) document.documentElement.classList.remove('has-native-dialog')
    }
    let dismissed = false
    const closed = () => {
      if (dismissed) return
      dismissed = true
      releaseBackdrop()
      close.current()
    }
    const dismiss = () => {
      if (dismissed) return
      // Close the native surface immediately, without waiting for a workspace render.
      releaseBackdrop()
      child.close()
      closed()
    }
    // Consume both pointerdown and the following click, so dismissing cannot
    // accidentally activate a button in the now-visible workspace.
    const outside = (event: PointerEvent) => {
      if (openDialogs.at(-1) !== token) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const consumeClick = (click: Event) => { click.preventDefault(); click.stopImmediatePropagation() }
      document.addEventListener('click', consumeClick, { capture: true, once: true })
      window.setTimeout(() => document.removeEventListener('click', consumeClick, true), 300)
      dismiss()
    }
    document.addEventListener('pointerdown', outside, true)
    child.addEventListener('beforeunload', closed)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); dismiss() }
    }
    child.addEventListener('keydown', keydown)
    setHost(target)
    reportDiagnostic('native-dialog.opened', JSON.stringify({ width, height }))
    return () => {
      releaseBackdrop()
      document.removeEventListener('pointerdown', outside, true)
      themeObserver.disconnect()
      styleObserver.disconnect()
      child.removeEventListener('beforeunload', closed)
      child.removeEventListener('keydown', keydown)
      if (!dismissed) child.close()
    }
  }, [width, height])
  useLayoutEffect(() => {
    if (!host) return
    const content = host.firstElementChild as HTMLElement | null
    if (!content) return
    // Explicit layout changes (e.g. cloud -> local) must resize immediately,
    // even if the child ResizeObserver has not delivered its next notification.
    host.scrollTop = 0
    content.scrollTop = 0
    if (content.firstElementChild) content.firstElementChild.scrollTop = 0
    const doc = host.ownerDocument
    doc.documentElement.scrollTop = 0
    doc.body.scrollTop = 0
    const view = doc.defaultView as (Window & typeof globalThis) | null
    const maxHeight = Math.max(240, window.screen.availHeight - 100)
    doc.documentElement.style.setProperty('--dialog-max-height', `${maxHeight}px`)
    let stopped = false
    let inFlight = false
    let acknowledged = ''
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const measure = async () => {
      if (stopped || inFlight) return
      const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      if (links.some((link) => !link.sheet)) return
      const panel = content.firstElementChild
      const preferred = panel ? parseFloat((view?.getComputedStyle?.(panel) ?? window.getComputedStyle(panel)).getPropertyValue('--dialog-preferred-width')) : NaN
      const nextWidth = Math.min(Number.isFinite(preferred) ? preferred : width, window.screen.availWidth || 1440)
      content.style.width = `${nextWidth}px`
      const nextHeight = Math.min(maxHeight, Math.ceil(content.getBoundingClientRect().height))
      const size = `${nextWidth}:${nextHeight}`
      if (nextHeight <= 0 || size === acknowledged) return
      inFlight = true
      try {
        const applied = await window.douchat.resizeDialog(name, nextWidth, nextHeight)
        if (stopped) return
        if (applied) { acknowledged = size; failures = 0 }
        else if (++failures >= 10) throw new Error('Dialog window was not registered')
      } catch (error) {
        reportDiagnostic('native-dialog.resize-failed', String(error))
        // A resize failure must never unmount an already-visible form.
        // Keep its current size and retry when content changes again.
        return
      } finally { inFlight = false }
      if (!stopped) retry = setTimeout(() => { void measure() }, 80)
    }
    const changed = () => { void measure() }
    const observer = new (view?.ResizeObserver ?? ResizeObserver)(changed)
    observer.observe(content)
    doc.addEventListener('load', changed, true)
    void doc.fonts?.ready.then(() => { if (!stopped) changed() })
    changed()
    return () => {
      stopped = true
      clearTimeout(retry)
      observer.disconnect()
      doc.removeEventListener('load', changed, true)
    }
  }, [host, name, width, layoutKey])
  if (failed) return <div role="alert">无法打开窗口，请重启应用后重试。<button onClick={onClose}>关闭</button></div>
  if (!host) return null
  return createPortal(<div {...props} className={`native-dialog-content ${className}`}>{children}</div>, host)
}
