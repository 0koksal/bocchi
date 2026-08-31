import React, { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Button } from './ui/button'

interface GithubDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const GithubDialog: React.FC<GithubDialogProps> = ({ open, onOpenChange }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>GitHub</DialogTitle>
          <DialogDescription>
            Source code repositories
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-elevated border border-border">
            <div className="min-w-[100px]">
              <p className="text-sm font-semibold text-text-primary">Original Bocchi</p>
              <p className="text-xs text-text-muted">(not working)</p>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text-secondary font-mono truncate">
                https://github.com/hoangvu12/bocchi
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-8 px-3 text-xs"
              onClick={() => handleCopy('https://github.com/hoangvu12/bocchi', 0)}
            >
              {copiedIndex === 0 ? (
                <span className="text-green-500">Copied!</span>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              )}
            </Button>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg bg-elevated border border-border">
            <div className="min-w-[100px]">
              <p className="text-sm font-semibold text-text-primary">Bocchi Reborn</p>
              <p className="text-xs text-text-muted">(Working)</p>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text-secondary font-mono truncate">
                https://github.com/0koksal/bocchi
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-8 px-3 text-xs"
              onClick={() => handleCopy('https://github.com/0koksal/bocchi', 1)}
            >
              {copiedIndex === 1 ? (
                <span className="text-green-500">Copied!</span>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              )}
            </Button>
          </div>
        </div>

        <div className="flex justify-end mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
