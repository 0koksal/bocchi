export type RepositoryStructureType = 'name-based' | 'id-based'

export interface RepositoryStructure {
  type: RepositoryStructureType
  skinsPath: string
  chromaPattern?: string
  fileExtension?: string // 'zip' | 'fantome' - default extension for files in this repo
  autoDetected: boolean
}

export interface SkinRepository {
  id: string
  name: string
  owner: string
  repo: string
  branch: string
  isDefault: boolean
  isCustom: boolean
  structure?: RepositoryStructure
  lastChecked?: Date
  status?: 'active' | 'error' | 'checking' | 'unchecked'
}

export interface RepositorySettings {
  repositories: SkinRepository[]
  activeRepositoryId: string
  allowMultipleActive: boolean
}

export interface RepositoryDetectionResult {
  type: RepositoryStructureType
  confidence: number
  skinsPath: string
  sampledPaths: string[]
  fileExtension?: string // detected file extension ('zip' or 'fantome')
  error?: string
}

export const DEFAULT_REPOSITORY_STRUCTURE: RepositoryStructure = {
  type: 'name-based',
  skinsPath: 'skins',
  autoDetected: false
}

export const DEFAULT_REPOSITORY: SkinRepository = {
  id: 'leagueskins-default',
  name: 'LeagueSkins Official',
  owner: 'Alban1911',
  repo: 'LeagueSkins',
  branch: 'main',
  isDefault: true,
  isCustom: false,
  structure: {
    type: 'id-based',
    skinsPath: 'skins',
    autoDetected: true
  },
  status: 'unchecked'
}

export const LEAGUESKINS_REPO = {
  owner: 'Alban1911',
  repo: 'LeagueSkins',
  branch: 'main',
  skinsPath: 'skins'
} as const
