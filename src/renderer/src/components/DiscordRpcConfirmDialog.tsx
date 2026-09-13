import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Button } from './ui/button'

// @ts-ignore – static asset imports
import cryingCatLeft from '../assets/cryingcatleft.gif'
// @ts-ignore
import cryingCatRight from '../assets/cryingcatright.gif'
// @ts-ignore
import cryingCatMp3 from '../assets/cryingcat.mp3'

interface DiscordRpcConfirmDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DiscordRpcConfirmDialog({
  open,
  onConfirm,
  onCancel
}: DiscordRpcConfirmDialogProps) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [countdown, setCountdown] = useState(5)

  useEffect(() => {
    if (open) {
      setCountdown(5)
      audioRef.current = new Audio(cryingCatMp3)
      audioRef.current.volume = 0.6
      audioRef.current.play().catch(() => {})

      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval)
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(interval)
    } else {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-[580px] overflow-hidden p-0 bg-surface border-border">
        {/* Cat gifs flanking the content */}
        <div className="flex items-stretch">
          {/* Left cat */}
          <div className="flex-shrink-0 w-24 flex items-end justify-center pb-2 bg-surface">
            <img
              src={cryingCatLeft}
              alt="crying cat"
              className="w-20 h-20 object-contain"
            />
          </div>

          {/* Main content */}
          <div className="flex-1 px-4 py-6 bg-surface">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-base font-bold text-center text-text-primary">
                😿 {t('settings.discordRpc.confirmTitle', 'Disable Discord Rich Presence?')}
              </DialogTitle>
              <DialogDescription className="text-center text-sm leading-relaxed mt-2 text-text-secondary">
                {t(
                  'settings.discordRpc.confirmBody1',
                  'Discord Rich Presence lets your friends see Bocchi in your status — every time someone spots it and asks "what\'s that?", our community grows a little bigger.'
                )}
                <br /><br />
                {t(
                  'settings.discordRpc.confirmBody2',
                  'Turning it off means fewer people discover Bocchi. Are you sure you want to disable it?'
                )}
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="flex gap-2 justify-center sm:justify-center">
              {/* Keep it on — green, darkens on hover */}
              <Button
                className="flex-1 bg-green-600 hover:bg-green-700 text-white transition-colors duration-200"
                onClick={onCancel}
              >
                {t('settings.discordRpc.keepItOn', 'Keep it on 💙')}
              </Button>

              {/* Disable anyway — locked with countdown, fixed width to prevent layout shift */}
              <Button
                variant="destructive"
                className="flex-1 min-w-[180px]"
                disabled={countdown > 0}
                onClick={onConfirm}
              >
                {countdown > 0
                  ? `${t('settings.discordRpc.disableAnyway', 'Disable anyway')} (${countdown})`
                  : t('settings.discordRpc.disableAnyway', 'Disable anyway')}
              </Button>
            </DialogFooter>
          </div>

          {/* Right cat */}
          <div className="flex-shrink-0 w-24 flex items-end justify-center pb-2 bg-surface">
            <img
              src={cryingCatRight}
              alt="crying cat"
              className="w-20 h-20 object-contain"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}