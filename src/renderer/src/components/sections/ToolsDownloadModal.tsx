import { useTranslation } from 'react-i18next'
import { useToolsManagement } from '../../hooks/useToolsManagement'
import { useStyles, useClassNames } from '../../hooks/useOptimizedState'
import {
  AlertCircle,
  AlertTriangle,
  Download,
  RefreshCw,
  ExternalLink,
  Loader2,
  FolderOpen
} from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'

export function ToolsDownloadModal() {
  const { t } = useTranslation()
  const {
    toolsExist,
    downloadingTools,
    toolsDownloadProgress,
    toolsError,
    downloadAttempts,
    downloadSpeed,
    downloadSize,
    downloadTools
  } = useToolsManagement()
  const styles = useStyles()
  const { getProgressBarFillStyle } = useClassNames()
  const [showDetails, setShowDetails] = useState(false)
  const [dllExists, setDllExists] = useState<boolean | null>(null)

  const checkDll = useCallback(async () => {
    if (toolsExist) {
      const exists = await window.api.checkDllExist()
      setDllExists(exists)
    }
  }, [toolsExist])

  // Check DLL when tools exist
  useEffect(() => {
    checkDll()
  }, [checkDll])

  // Poll for DLL when tools exist but DLL is missing
  useEffect(() => {
    if (!toolsExist || dllExists !== false) return
    const interval = setInterval(checkDll, 2000)
    return () => clearInterval(interval)
  }, [toolsExist, dllExists, checkDll])

  // Modal is hidden when both tools and DLL exist
  if (toolsExist && dllExists !== false) return null
  // Still loading DLL check
  if (toolsExist && dllExists === null) return null

  // Format bytes to human readable
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
  }

  // Format speed
  const formatSpeed = (bytesPerSecond: number) => {
    if (bytesPerSecond === 0) return ''
    return `${formatBytes(bytesPerSecond)}/s`
  }

  // Calculate ETA
  const calculateETA = () => {
    if (downloadSpeed === 0 || downloadSize.total === 0) return ''
    const remaining = downloadSize.total - downloadSize.loaded
    const seconds = remaining / downloadSpeed
    if (seconds < 60) return `${Math.round(seconds)}s remaining`
    const minutes = Math.round(seconds / 60)
    return `${minutes}m remaining`
  }

  // Get error icon based on type
  const getErrorIcon = () => {
    if (!toolsError) return null
    switch (toolsError.type) {
      case 'network':
        return '🌐'
      case 'github':
        return '📦'
      case 'filesystem':
        return '💾'
      case 'extraction':
        return '📂'
      case 'validation':
        return '⚠️'
      default:
        return '❌'
    }
  }

  // Get contextual help based on error type
  const getErrorHelp = () => {
    if (!toolsError) return null

    switch (toolsError.type) {
      case 'network':
        return (
          <ul className="text-xs text-text-secondary mt-2 space-y-1">
            <li>• Check your internet connection</li>
            <li>• Disable VPN if you&apos;re using one</li>
            <li>• Check firewall settings</li>
            <li>• Try again in a few minutes</li>
          </ul>
        )
      case 'github':
        if (toolsError.message.includes('rate limit')) {
          return (
            <ul className="text-xs text-text-secondary mt-2 space-y-1">
              <li>• GitHub has temporary download limits</li>
              <li>• Wait an hour and try again</li>
              <li>• Or download manually using the link below</li>
            </ul>
          )
        }
        return null
      case 'filesystem':
        return (
          <ul className="text-xs text-text-secondary mt-2 space-y-1">
            <li>• Run Bocchi as Administrator</li>
            <li>• Check available disk space</li>
            <li>• Ensure the installation folder is writable</li>
          </ul>
        )
      case 'extraction':
        return (
          <ul className="text-xs text-text-secondary mt-2 space-y-1">
            <li>• The download may be corrupted</li>
            <li>• Try downloading again</li>
            <li>• Check if antivirus is blocking the file</li>
          </ul>
        )
      default:
        return null
    }
  }

  const handleManualDownload = () => {
    window.api.openExternal('https://github.com/LeagueToolkit/cslol-manager/releases/latest')
  }

  const handleRetry = () => {
    downloadTools(true)
  }

  const handleOpenToolsFolder = () => {
    window.api.openToolsFolder()
  }

  // Phase 2: Tools downloaded but DLL missing
  if (toolsExist && dllExists === false) {
    return (
      <div className={styles.toolsModalOverlay.className}>
        <div className={styles.toolsModalContent.className}>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-yellow-500/10 rounded-lg">
              <AlertTriangle className="w-6 h-6 text-yellow-500" />
            </div>
            <h3 className="text-xl font-bold text-text-primary">{t('tools.dllRequired')}</h3>
          </div>

          <div className="space-y-4">
            <p className="text-text-secondary leading-relaxed text-sm">
              {t('tools.dllDmcaNotice')}
            </p>

            <p className="text-text-secondary leading-relaxed text-sm">
              {t('tools.dllInstructions')}
            </p>

            <p className="text-xs text-text-tertiary">{t('tools.dllWithoutNotice')}</p>

            <button
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#5865F2] hover:bg-[#4752C4] text-white rounded-lg transition-colors font-medium"
              onClick={() => window.open('https://discord.gg/FVxNNhzNcP', '_blank')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.037c-.211.375-.444.865-.608 1.249a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.249.077.077 0 0 0-.079-.037c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.201 13.201 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.027 19.839 19.839 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028zM8.02 15.278c-1.182 0-2.157-1.069-2.157-2.38 0-1.312.956-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.956 2.38-2.157 2.38zm7.975 0c-1.183 0-2.157-1.069-2.157-2.38 0-1.312.955-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.946 2.38-2.157 2.38z" />
              </svg>
              Join Discord
            </button>

            <button
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors font-medium"
              onClick={handleOpenToolsFolder}
            >
              <FolderOpen className="w-5 h-5" />
              {t('tools.openToolsFolder')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Phase 1: Tools not downloaded
  return (
    <div className={styles.toolsModalOverlay.className}>
      <div className={styles.toolsModalContent.className}>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-primary-500/10 rounded-lg">
            <Download className="w-6 h-6 text-primary-500" />
          </div>
          <h3 className="text-xl font-bold text-text-primary">{t('tools.required')}</h3>
        </div>

        <p className="text-text-secondary mb-6 leading-relaxed">{t('tools.description')}</p>

        {/* Error State */}
        {toolsError && !downloadingTools && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
            <div className="flex items-start gap-3">
              <span className="text-2xl">{getErrorIcon()}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-4 h-4 text-red-400" />
                  <h4 className="font-semibold text-red-400">{toolsError.message}</h4>
                </div>
                {toolsError.details && (
                  <p className="text-sm text-red-300/80 mb-2">{toolsError.details}</p>
                )}
                {downloadAttempts > 0 && (
                  <p className="text-xs text-red-300/60 mb-2">
                    Attempt {downloadAttempts} of 3 failed
                  </p>
                )}
                {getErrorHelp()}

                {/* Collapsible details */}
                {toolsError.details && (
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="text-xs text-red-300/60 hover:text-red-300 mt-2"
                  >
                    {showDetails ? 'Hide' : 'Show'} technical details
                  </button>
                )}
                {showDetails && toolsError.details && (
                  <div className="mt-2 p-2 bg-black/20 rounded text-xs font-mono text-red-300/60">
                    {toolsError.details}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Download Progress */}
        {downloadingTools ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary-500" />
              <span className="text-text-secondary text-sm">
                {t('tools.downloading', { progress: toolsDownloadProgress })}
              </span>
            </div>

            {/* Progress bar */}
            <div className={styles.progressBar.className}>
              <div
                className="bg-primary-500 h-full transition-all duration-300 relative overflow-hidden"
                style={getProgressBarFillStyle(toolsDownloadProgress)}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-progress"></div>
              </div>
            </div>

            {/* Download details */}
            <div className="flex items-center justify-between mt-2 text-xs text-text-secondary">
              <div className="flex items-center gap-3">
                {downloadSize.total > 0 && (
                  <span>
                    {formatBytes(downloadSize.loaded)} / {formatBytes(downloadSize.total)}
                  </span>
                )}
                {downloadSpeed > 0 && (
                  <span className="text-primary-400">{formatSpeed(downloadSpeed)}</span>
                )}
              </div>
              {calculateETA() && <span className="text-text-tertiary">{calculateETA()}</span>}
            </div>

            {downloadAttempts > 1 && (
              <p className="text-xs text-text-secondary mt-3 text-center">
                Retry attempt {downloadAttempts} of 3
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Primary action buttons */}
            {toolsError && toolsError.canRetry ? (
              <div className="flex gap-3">
                <button
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors font-medium"
                  onClick={handleRetry}
                  disabled={downloadAttempts >= 3}
                >
                  <RefreshCw className="w-4 h-4" />
                  {downloadAttempts >= 3 ? t('tools.maxRetriesReached') : t('tools.retryDownload')}
                </button>
                <button
                  className="px-4 py-3 bg-surface-lighter hover:bg-surface-light text-text-secondary rounded-lg transition-colors"
                  onClick={handleManualDownload}
                  title={t('tools.downloadManuallyFromGithub')}
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                className={`${styles.downloadButton.className} flex items-center justify-center gap-2`}
                onClick={() => downloadTools(false)}
              >
                <Download className="w-5 h-5" />
                <span>{t('tools.downloadTools')}</span>
              </button>
            )}

            {/* Manual download option */}
            {(toolsError || downloadAttempts >= 2) && (
              <div className="pt-3 border-t border-surface-border">
                <p className="text-xs text-text-secondary mb-2">{t('tools.havingTrouble')}</p>
                <button
                  onClick={handleManualDownload}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-surface-lighter hover:bg-surface-light text-text-secondary rounded-lg transition-colors text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  {t('tools.downloadManuallyFromGithub')}
                </button>
                <p className="text-xs text-text-tertiary mt-2">
                  {t('tools.extractTo')} {`%APPDATA%\\bocchi\\cslol-tools`}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
