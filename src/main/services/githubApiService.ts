import axios from 'axios'
import { repositoryService } from './repositoryService'
import { LEAGUESKINS_REPO } from '../types/repository.types'

export interface GitHubCommit {
  sha: string
  date: Date
  message: string
}

export class GitHubApiService {
  private static readonly API_BASE = 'https://api.github.com'
  private static readonly RATE_LIMIT_DELAY = 1000 // 1 second between requests

  private lastRequestTime = 0

  async getLatestCommitForSkin(skinPath: string): Promise<GitHubCommit | null> {
    try {
      // Rate limiting
      await this.enforceRateLimit()

      const repo = LEAGUESKINS_REPO
      const repoPath = `${repo.owner}/${repo.repo}`

      const url = `${GitHubApiService.API_BASE}/repos/${repoPath}/commits`
      const params = {
        path: skinPath,
        page: 1,
        per_page: 1,
        ref: repo.branch
      }

      console.log(`[GitHubAPI] Fetching commit for: ${skinPath} from ${repoPath}`)

      const response = await axios.get(url, {
        params,
        timeout: 10000, // 10 second timeout
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Bocchi-LoL-Skin-Manager'
        }
      })

      if (response.status === 200 && response.data.length > 0) {
        const commit = response.data[0]
        return {
          sha: commit.sha,
          date: new Date(commit.commit.author.date),
          message: commit.commit.message
        }
      }

      console.warn(`[GitHubAPI] No commits found for: ${skinPath} in ${repoPath}`)
      return null
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          console.warn(`[GitHubAPI] Skin not found: ${skinPath}`)
          return null
        } else if (error.response?.status === 403) {
          console.warn('[GitHubAPI] Rate limit exceeded, will retry later')
          throw new Error('GitHub API rate limit exceeded')
        } else if (error.response?.status && error.response.status >= 500) {
          console.warn('[GitHubAPI] GitHub server error')
          throw new Error('GitHub server error')
        }
      }

      console.error(`[GitHubAPI] Error fetching commit for ${skinPath}:`, error)
      throw error
    }
  }

  /**
   * Searches the champion folder subtree for a skin file. Used as a fallback
   * when the constructed URL 404s (e.g. the repo structure changed and the
   * file lives somewhere else under the champion folder than expected).
   * Returns a raw download URL for the file, or null if not found.
   */
  async findSkinFileByUrl(url: string): Promise<string | null> {
    try {
      const parsed = repositoryService.parseGitHubUrl(url)
      if (!parsed) return null

      const path = decodeURIComponent(parsed.path)
      const segments = path.split('/')
      const skinsIdx = segments.indexOf(LEAGUESKINS_REPO.skinsPath)
      // Need at least skins/{championFolder}/{fileName}
      if (skinsIdx === -1 || segments.length < skinsIdx + 3) return null

      const championFolder = segments[skinsIdx + 1]
      const fileName = segments[segments.length - 1]
      const fileBase = fileName.replace(/\.(zip|fantome)$/i, '').toLowerCase()
      if (!fileBase) return null

      const headers = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Bocchi-LoL-Skin-Manager'
      }

      // Find the champion folder entry to get its subtree SHA
      await this.enforceRateLimit()
      const contentsResponse = await axios.get(
        `${GitHubApiService.API_BASE}/repos/${parsed.owner}/${parsed.repo}/contents/${LEAGUESKINS_REPO.skinsPath}`,
        { params: { ref: parsed.branch }, timeout: 10000, headers }
      )
      const championEntry = (
        contentsResponse.data as Array<{ name: string; sha: string; type: string }>
      ).find((e) => e.type === 'dir' && e.name.toLowerCase() === championFolder.toLowerCase())
      if (!championEntry) return null

      // List every file under the champion folder and match by file base name
      await this.enforceRateLimit()
      const treeResponse = await axios.get(
        `${GitHubApiService.API_BASE}/repos/${parsed.owner}/${parsed.repo}/git/trees/${championEntry.sha}`,
        { params: { recursive: '1' }, timeout: 15000, headers }
      )
      const entries = treeResponse.data?.tree as Array<{ path: string; type: string }> | undefined
      if (!entries) return null

      const match = entries.find((e) => {
        if (e.type !== 'blob') return false
        const base = e.path.split('/').pop()?.replace(/\.(zip|fantome)$/i, '').toLowerCase()
        return base === fileBase
      })
      if (!match) return null

      console.log(`[GitHubAPI] Champion folder search found: ${match.path}`)
      return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${match.path}`
    } catch (error) {
      console.warn('[GitHubAPI] Champion folder search failed:', error)
      return null
    }
  }

  parseGitHubPathFromUrl(url: string): string {
    // Convert GitHub URL to file path for API
    // Works with any repository structure
    // Example: https://github.com/owner/repo/blob/branch/path/to/file.zip
    // Result: path/to/file.zip

    try {
      const parsed = repositoryService.parseGitHubUrl(url)
      if (!parsed) {
        throw new Error('Invalid GitHub URL format')
      }

      // Decode URL encoding
      return decodeURIComponent(parsed.path)
    } catch (error) {
      console.error(`[GitHubAPI] Failed to parse GitHub path from URL: ${url}`, error)
      throw new Error(`Invalid GitHub URL: ${url}`)
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < GitHubApiService.RATE_LIMIT_DELAY) {
      const waitTime = GitHubApiService.RATE_LIMIT_DELAY - timeSinceLastRequest
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    this.lastRequestTime = Date.now()
  }
}

// Export singleton instance
export const githubApiService = new GitHubApiService()
