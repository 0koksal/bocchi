import './assets/main.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Debug info for troubleshooting
console.log('%c[Bocchi] v1.25.2-modded', 'color: #22c55e; font-weight: bold; font-size: 14px')
console.log('[Bocchi] If you encounter a bug, screenshot the console (F12) and send it to @Koksal on Discord')
console.log('[Bocchi] Platform:', navigator.platform, '| UserAgent:', navigator.userAgent)

// Global error handler for unhandled errors
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Bocchi] Unhandled Promise Rejection:', event.reason)
})

window.addEventListener('error', (event) => {
  console.error('[Bocchi] Uncaught Error:', event.error || event.message)
})

// Import themes and apply default theme before React renders
import { getThemeById, defaultLightTheme, defaultDarkTheme } from './themes/themes'
import { applyTheme } from './themes/utils'

// Apply initial theme based on stored preference or system preference
const storedConfig = localStorage.getItem('bocchi-theme-config')
let initialTheme = defaultLightTheme

if (storedConfig) {
  try {
    const config = JSON.parse(storedConfig)
    const isDark =
      config.mode === 'dark' ||
      (config.mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    const themeId = `${config.themeId}-${isDark ? 'dark' : 'light'}`
    initialTheme = getThemeById(themeId) || (isDark ? defaultDarkTheme : defaultLightTheme)
  } catch {
    // Use default
  }
} else {
  // Check legacy dark mode setting
  const legacyDarkMode = localStorage.getItem('darkMode')
  if (legacyDarkMode === 'true') {
    initialTheme = defaultDarkTheme
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    initialTheme = defaultDarkTheme
  }
}

// Apply theme before React renders to prevent flash
applyTheme(initialTheme)

// Add loaded class to body to fade in the content
document.body.classList.add('loaded')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
