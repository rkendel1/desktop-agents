export interface SpeechRecognitionAlternativeLike {
  transcript: string
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

export interface SpeechRecognitionResultListLike {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string
  readonly message?: string
}

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onstart: ((event: Event) => void) | null
  onend: ((event: Event) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export function speechRecognitionConstructor(
  source: SpeechRecognitionWindow = window as unknown as SpeechRecognitionWindow
): SpeechRecognitionConstructor | undefined {
  return source.SpeechRecognition ?? source.webkitSpeechRecognition
}

export function speechRecognitionLanguage(documentLanguage: string): string {
  return documentLanguage.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Returns a translation key so the component can localise the browser error. */
export function speechRecognitionErrorMessage(error: string, microphoneConfirmed = false): string {
  if (
    error === 'service-not-allowed'
    || (microphoneConfirmed && (error === 'not-allowed' || error === 'network'))
  ) {
    return 'Voice recognition service is unavailable in this version of Foundry.'
  }
  if (error === 'not-allowed') {
    return 'Microphone access is off. Allow Foundry in System Settings, then restart the app.'
  }
  if (error === 'audio-capture') return 'No microphone was found.'
  if (error === 'no-speech') return 'No speech was detected. Try again.'
  if (error === 'network') return 'Voice recognition could not connect. Check your network and try again.'
  return 'Voice input stopped unexpectedly. Try again.'
}
