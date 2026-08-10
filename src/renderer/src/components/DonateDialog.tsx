import React, { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Button } from './ui/button'

interface DonateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CRYPTO_ADDRESSES = [
  { name: 'Binance ID', network: 'Binance', address: '39713103' },
  { name: 'BTC', network: 'Bitcoin', address: '15VegBx8uSYeugUqhvNh4F7fkXfehkKNRw' },
  { name: 'BTC', network: 'BEP20', address: '0x4c44c4fb2fe473cacfd70fcfc3bf3f4e581cab25' },
  { name: 'USDT', network: 'TRC-20', address: 'TAiYrZD9i4yup3VZdCcE2NVPknYdh5upNc' },
  { name: 'USDT', network: 'ERC-20', address: '0x4c44c4fb2fe473cacfd70fcfc3bf3f4e581cab25' },
  { name: 'ETH', network: 'Ethereum', address: '0x4c44c4fb2fe473cacfd70fcfc3bf3f4e581cab25' },
  { name: 'LTC', network: 'Litecoin', address: 'LPEC7DY3ztZXjUZWfQxnEcbL8D73tKtXzY' },
  { name: 'SOL', network: 'Solana', address: '5LN5bnGJRV6zUg2VcD9M6Tyhr5nU8ACAwy2wCVB9Ckrm' },
  { name: 'Bocchi KO-FI', address: 'https://ko-fi.com/hoangvu12' }
]

export const DonateDialog: React.FC<DonateDialogProps> = ({ open, onOpenChange }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = async (address: string, index: number) => {
    await navigator.clipboard.writeText(address)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Donate With Crypto</DialogTitle>
          <DialogDescription>
            Any Support Appreciated
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {CRYPTO_ADDRESSES.map((crypto, index) => (
            <div
              key={index}
              className="flex items-center gap-3 p-3 rounded-lg bg-elevated border border-border"
            >
              <div className="min-w-[80px]">
                <p className="text-sm font-semibold text-text-primary">{crypto.name}</p>
                <p className="text-xs text-text-muted">{crypto.network}</p>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-secondary font-mono truncate">
                  {crypto.address}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 h-8 px-3 text-xs"
                onClick={() => handleCopy(crypto.address, index)}
              >
                {copiedIndex === index ? (
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
          ))}
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
