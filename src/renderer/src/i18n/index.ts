import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enUS from '../locales/en_US/translation.json'
import enAU from '../locales/en_AU/translation.json'
import enGB from '../locales/en_GB/translation.json'
import enPH from '../locales/en_PH/translation.json'
import enSG from '../locales/en_SG/translation.json'
import viVN from '../locales/vi_VN/translation.json'
import esAR from '../locales/es_AR/translation.json'
import esES from '../locales/es_ES/translation.json'
import esMX from '../locales/es_MX/translation.json'
import jaJP from '../locales/ja_JP/translation.json'
import koKR from '../locales/ko_KR/translation.json'
import zhCN from '../locales/zh_CN/translation.json'
import ruRU from '../locales/ru_RU/translation.json'
import arAE from '../locales/ar_AE/translation.json'
import ptBR from '../locales/pt_BR/translation.json'
import idID from '../locales/id_ID/translation.json'
import thTH from '../locales/th_TH/translation.json'
import zhMY from '../locales/zh_MY/translation.json'
import zhTW from '../locales/zh_TW/translation.json'
import csCZ from '../locales/cs_CZ/translation.json'
import deDE from '../locales/de_DE/translation.json'
import elGR from '../locales/el_GR/translation.json'
import frFR from '../locales/fr_FR/translation.json'
import huHU from '../locales/hu_HU/translation.json'
import itIT from '../locales/it_IT/translation.json'
import plPL from '../locales/pl_PL/translation.json'
import roRO from '../locales/ro_RO/translation.json'
import trTR from '../locales/tr_TR/translation.json'
import tlPH from '../locales/tl_PH/translation.json'
import msMY from '../locales/ms_MY/translation.json'
import bgBG from '../locales/bg_BG/translation.json'
import ptPT from '../locales/pt_PT/translation.json'

export const supportedLanguages = [
  { code: 'en_US', name: 'English', flag: '🇺🇸' },
  { code: 'en_AU', name: 'English (Australia)', flag: '🇦🇺' },
  { code: 'en_GB', name: 'English (United Kingdom)', flag: '🇬🇧' },
  { code: 'en_PH', name: 'English (Philippines)', flag: '🇵🇭' },
  { code: 'en_SG', name: 'English (Singapore)', flag: '🇸🇬' },
  { code: 'vi_VN', name: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'es_AR', name: 'Español (Argentina)', flag: '🇦🇷' },
  { code: 'es_ES', name: 'Español (España)', flag: '🇪🇸' },
  { code: 'es_MX', name: 'Español (México)', flag: '🇲🇽' },
  { code: 'ja_JP', name: '日本語', flag: '🇯🇵' },
  { code: 'ko_KR', name: '한국어', flag: '🇰🇷' },
  { code: 'zh_CN', name: '简体中文', flag: '🇨🇳' },
  { code: 'ru_RU', name: 'Русский', flag: '🇷🇺' },
  { code: 'ar_AE', name: 'العربية', flag: '🇦🇪' },
  { code: 'pt_BR', name: 'Português (Brasil)', flag: '🇧🇷' },
  { code: 'id_ID', name: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'th_TH', name: 'ไทย', flag: '🇹🇭' },
  { code: 'zh_MY', name: '繁體中文 (馬來西亞)', flag: '🇲🇾' },
  { code: 'zh_TW', name: '繁體中文 (台灣)', flag: '🇹🇼' },
  { code: 'cs_CZ', name: 'Čeština', flag: '🇨🇿' },
  { code: 'de_DE', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'el_GR', name: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'fr_FR', name: 'Français', flag: '🇫🇷' },
  { code: 'hu_HU', name: 'Magyar', flag: '🇭🇺' },
  { code: 'it_IT', name: 'Italiano', flag: '🇮🇹' },
  { code: 'pl_PL', name: 'Polski', flag: '🇵🇱' },
  { code: 'ro_RO', name: 'Română', flag: '🇷🇴' },
  { code: 'tr_TR', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'tl_PH', name: 'Filipino', flag: '🇵🇭' },
  { code: 'ms_MY', name: 'Bahasa Melayu', flag: '🇲🇾' },
  { code: 'bg_BG', name: 'Български', flag: '🇧🇬' },
  { code: 'pt_PT', name: 'Português (Portugal)', flag: '🇵🇹' }
] as const

export type LanguageCode = (typeof supportedLanguages)[number]['code']

const resources = {
  en_US: {
    translation: enUS
  },
  en_AU: {
    translation: enAU
  },
  en_GB: {
    translation: enGB
  },
  en_PH: {
    translation: enPH
  },
  en_SG: {
    translation: enSG
  },
  vi_VN: {
    translation: viVN
  },
  es_AR: {
    translation: esAR
  },
  es_ES: {
    translation: esES
  },
  es_MX: {
    translation: esMX
  },
  ja_JP: {
    translation: jaJP
  },
  ko_KR: {
    translation: koKR
  },
  zh_CN: {
    translation: zhCN
  },
  ru_RU: {
    translation: ruRU
  },
  ar_AE: {
    translation: arAE
  },
  pt_BR: {
    translation: ptBR
  },
  id_ID: {
    translation: idID
  },
  th_TH: {
    translation: thTH
  },
  zh_MY: {
    translation: zhMY
  },
  zh_TW: {
    translation: zhTW
  },
  cs_CZ: {
    translation: csCZ
  },
  de_DE: {
    translation: deDE
  },
  el_GR: {
    translation: elGR
  },
  fr_FR: {
    translation: frFR
  },
  hu_HU: {
    translation: huHU
  },
  it_IT: {
    translation: itIT
  },
  pl_PL: {
    translation: plPL
  },
  ro_RO: {
    translation: roRO
  },
  tr_TR: {
    translation: trTR
  },
  tl_PH: {
    translation: tlPH
  },
  ms_MY: {
    translation: msMY
  },
  bg_BG: {
    translation: bgBG
  },
  pt_PT: {
    translation: ptPT
  }
}

// Initialize i18n
i18n.use(initReactI18next).init({
  resources,
  lng: 'en_US',
  fallbackLng: 'en_US',
  debug: false,

  interpolation: {
    escapeValue: false
  },

  react: {
    useSuspense: false
  }
})

export default i18n
