import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { selectedSkinsAtom, type SelectedSkin } from '../store/atoms'
import { arenaBraveryRandomSkinsEnabledAtom, currentQueueIdAtom } from '../store/atoms/lcu.atoms'
import {
  autoApplyEnabledAtom,
  championDetectionEnabledAtom,
  leagueClientEnabledAtom
} from '../store/atoms/settings.atoms'
import { statusMessageAtom } from '../store/atoms/game.atoms'
import { generateSkinFilename } from '../../../shared/utils/skinFilename'
import { getChampionDisplayName } from '../utils/championUtils'
import type { Champion } from '../App'

export function useArenaBraverySkins(
  champions: Champion[] | undefined,
  gamePath: string | undefined,
  applySelectedSkins: (championIds?: number[], forceAllChampions?: boolean) => Promise<void>,
  loadDownloadedSkins: () => Promise<void>
): void {
  const enabled = useAtomValue(arenaBraveryRandomSkinsEnabledAtom)
  const leagueClientEnabled = useAtomValue(leagueClientEnabledAtom)
  const championDetectionEnabled = useAtomValue(championDetectionEnabledAtom)
  const autoApplyEnabled = useAtomValue(autoApplyEnabledAtom)
  const queueId = useAtomValue(currentQueueIdAtom)
  const [selectedSkins, setSelectedSkins] = useAtom(selectedSkinsAtom)
  const [, setStatusMessage] = useAtom(statusMessageAtom)
  const [prepared, setPrepared] = useState<SelectedSkin[] | null>(null)
  const preparing = useRef(false)
  const applied = useRef(false)

  useEffect(() => {
    if (!enabled || !leagueClientEnabled || !championDetectionEnabled) {
      preparing.current = false
      applied.current = false
      setPrepared(null)
      setSelectedSkins((previous) =>
        previous.some((skin) => skin.isArenaPrepared)
          ? previous.filter((skin) => !skin.isArenaPrepared)
          : previous
      )
      return
    }
    if (!champions?.length || preparing.current) return

    let cancelled = false
    preparing.current = true

    const prepare = async () => {
      const downloads = await window.api.listDownloadedSkins()
      if (!downloads.success) throw new Error(downloads.error || 'Cannot list downloaded skins')
      const includeChromas = await window.api.getSettings('includeChromasInRandom')
      const skins: SelectedSkin[] = []

      for (const champion of champions) {
        if (cancelled) return
        const options = champion.skins.filter((skin) => skin.num !== 0)
        if (options.length === 0) throw new Error(`No available skin for ${champion.name}`)
        const skin = options[Math.floor(Math.random() * options.length)]
        let chromaId: string | undefined
        if (includeChromas && skin.chromaList?.length) {
          const pick = Math.floor(Math.random() * (skin.chromaList.length + 1))
          if (pick > 0) chromaId = String(skin.chromaList[pick - 1].id)
        }
        const fileName = generateSkinFilename({ ...skin, chromaId })
        const baseName = fileName.replace(/\.(zip|fantome)$/i, '')
        const cached = downloads.skins?.some(
          (entry) =>
            (entry.championName === champion.key || entry.championName === champion.name) &&
            entry.skinName.replace(/\.(zip|fantome)$/i, '') === baseName
        )
        if (!cached) {
          const displayName = getChampionDisplayName(champion)
          const url = chromaId
            ? await window.api.repositoryConstructUrl(
                displayName,
                fileName,
                true,
                baseName.replace(/\s+\d+$/, ''),
                champion.id,
                skin.skinType === 'classic'
              )
            : await window.api.repositoryConstructUrl(
                displayName,
                skin.skinType === 'classic' ? skin.id : fileName,
                false,
                undefined,
                champion.id,
                skin.skinType === 'classic'
              )
          if (!url.success || !url.url) throw new Error(`Cannot find ${champion.name} skin`)
          const result = await window.api.downloadSkin(url.url)
          if (!result.success)
            throw new Error(result.error || `Cannot download ${champion.name} skin`)
        }
        skins.push({
          championKey: champion.key,
          championName: champion.name,
          championId: champion.id,
          skinId: skin.id,
          skinName: skin.name,
          skinNameEn: generateSkinFilename(skin),
          skinNum: skin.num,
          chromaId,
          downloadedFilename: `${fileName}.zip`,
          isDownloaded: true,
          isAutoSelected: true,
          isArenaPrepared: true
        })
        setStatusMessage(`Arena Bravery: ${skins.length}/${champions.length} skins ready`)
      }

      if (!cancelled) {
        await loadDownloadedSkins()
        if (cancelled) return
        setPrepared(skins)
        setStatusMessage('Arena Bravery: skins downloaded; waiting for Arena queue')
      }
    }

    prepare().catch((error) => {
      if (!cancelled)
        setStatusMessage(
          `Arena Bravery preparation failed: ${error instanceof Error ? error.message : String(error)}`
        )
    })

    return () => {
      cancelled = true
      preparing.current = false
    }
  }, [
    enabled,
    leagueClientEnabled,
    championDetectionEnabled,
    champions,
    loadDownloadedSkins,
    setSelectedSkins,
    setStatusMessage
  ])

  useEffect(() => {
    if (
      queueId !== 1700 ||
      !prepared ||
      !enabled ||
      !autoApplyEnabled ||
      !gamePath ||
      applied.current
    )
      return
    let cancelled = false
    applied.current = true

    window.api.lcuGetStatus().then((status) => {
      if (cancelled) return
      if (!['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect'].includes(status.gameflowPhase)) {
        setStatusMessage('Arena Bravery: preparation finished too late for this match')
        return
      }
      setSelectedSkins((previous) => [
        ...previous.filter((skin) => !skin.isAutoSelected),
        ...prepared
      ])
    })

    return () => {
      cancelled = true
    }
  }, [queueId, prepared, enabled, autoApplyEnabled, gamePath, setSelectedSkins, setStatusMessage])

  useEffect(() => {
    if (!prepared || !applied.current || queueId !== 1700 || !autoApplyEnabled || !gamePath) return
    if (
      !prepared.every((skin) =>
        selectedSkins.some(
          (selected) =>
            selected.championKey === skin.championKey &&
            selected.isArenaPrepared &&
            selected.skinId === skin.skinId &&
            selected.chromaId === skin.chromaId
        )
      )
    )
      return

    let cancelled = false
    applied.current = false
    window.api.lcuGetStatus().then((status) => {
      if (
        !cancelled &&
        ['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect'].includes(status.gameflowPhase)
      ) {
        void applySelectedSkins(undefined, true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [prepared, selectedSkins, queueId, autoApplyEnabled, gamePath, applySelectedSkins])

  useEffect(() => {
    const unsubscribe = window.api.onLcuQueueIdDetected(({ queueId: detectedQueueId }) => {
      if (detectedQueueId !== 1700) {
        applied.current = false
        setSelectedSkins((previous) =>
          previous.some((skin) => skin.isArenaPrepared)
            ? previous.filter((skin) => !skin.isArenaPrepared)
            : previous
        )
      }
    })
    return unsubscribe
  }, [setSelectedSkins])
}
