import type { GoogleOAuthClient } from './google-oauth'

/**
 * The OAuth client ASIST signs in to Google with, or null when the build has none. electron.vite.config.ts
 * embeds ASIST_GOOGLE_CLIENT_ID and ASIST_GOOGLE_CLIENT_SECRET from the environment of the build, which CI
 * fills from its secrets, or from .env for a run from the repository; the repository never holds them.
 */
export function googleOAuthClient(): GoogleOAuthClient | null {
  const id = ASIST_GOOGLE_CLIENT_ID.trim()
  const secret = ASIST_GOOGLE_CLIENT_SECRET.trim()
  return id && secret ? { id, secret } : null
}
