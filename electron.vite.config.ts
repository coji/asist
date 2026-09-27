import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Adds bundled-packages-<name>.json to the output of a bundle: the folders of the npm packages whose code
 * it took in, from which scripts/third-party-notices.mjs collects their licenses. The renderer and its
 * workers take in development dependencies such as Transformers.js, which package.json alone would not
 * show. Each worker is a bundle of its own, so the name comes from the bundle's entry.
 */
function bundledPackages(): Plugin {
  return {
    name: 'bundled-packages',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>()
      let entry = 'bundle'
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        if (output.isEntry) entry = output.name
        for (const id of Object.keys(output.modules)) {
          // The last node_modules in the path is the package itself when one package nests another.
          const match = /^.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+/.exec(id.replace(/^\0/, ''))
          if (match) dirs.add(match[0])
        }
      }
      this.emitFile({ type: 'asset', fileName: `bundled-packages-${entry}.json`, source: JSON.stringify([...dirs].sort(), null, 2) })
    }
  }
}

/**
 * The OAuth client of Google, embedded in the main process from the environment of the build or from .env.
 * CI passes them from its secrets to the jobs that package the app, and they are never in the repository.
 * An empty value leaves the app without Google Calendar, which only ASIST_CALENDAR_BACKEND=google asks for.
 */
function googleClientDefines(mode: string): Record<string, string> {
  const env = loadEnv(mode, process.cwd(), 'ASIST_GOOGLE_')
  return {
    ASIST_GOOGLE_CLIENT_ID: JSON.stringify(env.ASIST_GOOGLE_CLIENT_ID ?? ''),
    ASIST_GOOGLE_CLIENT_SECRET: JSON.stringify(env.ASIST_GOOGLE_CLIENT_SECRET ?? '')
  }
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin(), bundledPackages()],
    define: googleClientDefines(mode),
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), bundledPackages()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss(), bundledPackages()],
    worker: {
      plugins: () => [bundledPackages()]
    }
  }
}))
