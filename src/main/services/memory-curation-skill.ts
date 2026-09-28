import fs from 'node:fs'
import path from 'node:path'
import type { ConversationLocale } from '@shared/conversation-locale'
import { CURATION_SKILL, FORMAT_MODULE, SKILL_DIRS, curationSkillSource, worktreeAgentsMd } from '@shared/memory-curation'
import { conversationLocale } from './conversation-locale'
import { resourcePath } from './resource-path'

/** The skill written in the prompt language of the conversation, read on every call so a change applies at once. */
export function skillSourceDir(locale: ConversationLocale = conversationLocale()): string {
  return resourcePath(path.join('skills', curationSkillSource(locale)))
}

/**
 * Installs the skill into every directory an agent looks in, one for claude and one for codex, with the
 * rules its validate.mjs imports beside it, and writes AGENTS.md. Both locations are listed in .gitignore,
 * so the worktree stays clean.
 */
export function installSkill(worktreeDir: string, source = skillSourceDir()): void {
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`the memory curation skill is missing: ${source}`)
  for (const dir of SKILL_DIRS) {
    const target = path.join(worktreeDir, dir, CURATION_SKILL)
    fs.rmSync(target, { recursive: true, force: true })
    copyFolder(source, target)
    fs.copyFileSync(path.join(path.dirname(source), FORMAT_MODULE), path.join(worktreeDir, dir, FORMAT_MODULE))
  }
  fs.writeFileSync(path.join(worktreeDir, 'AGENTS.md'), worktreeAgentsMd(conversationLocale()), { mode: 0o600 })
}

/**
 * Copies the folder source to target file by file. fs.cpSync of a folder ended Node 22.23.2 on Windows with an
 * access violation whenever either path held a character outside ASCII, as a worktree named after a Japanese
 * job title does; Electron's Node 24.18 copied the same folder, but the tests run on Node 22 (2026-09-27).
 */
function copyFolder(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyFolder(from, to)
    else fs.copyFileSync(from, to)
  }
}
