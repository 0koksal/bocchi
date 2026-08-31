import { createContext } from 'react'
import { LanguageCode, supportedLanguages } from '../i18n'

export interface LocaleContextType {
  currentLanguage: LanguageCode
  setLanguage: (lang: LanguageCode) => Promise<void>
  languages: typeof supportedLanguages
}

export const LocaleContext = createContext<LocaleContextType | null>(null)
