import { ExternalLink } from 'lucide-react'
import { AGENT_INSTALL_GUIDE, type SettingsContext } from '../context'
import { useFieldDraft } from '@/ui/field-draft'
import { Btn, Chip, Group, NotSavedHint, Page, Row } from '../primitives'
import { PrepLine } from '../preparation'
import { useT } from '@/i18n'
import { AGENT_CLI_UNAVAILABLE_TEXT, AGENT_MODE_NAME } from '@shared/agent-cli'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/** The Agent page: the engine of the working agent with the way to install its CLI, its permissions and the directory it works in. */
export function AgentPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, set } = ctx
  /** Opens the system's folder dialog at `startAt` and hands the chosen folder on. A dismissed dialog changes nothing. */
  const chooseFolder = (startAt: string | undefined, use: (folder: string) => void): void => {
    void window.api.folderChoose(startAt).then((folder) => {
      if (folder) use(folder)
    })
  }
  const t = useT()
  const cwd = useFieldDraft(settings.agentCwd, { format: (folder) => folder, parse: (text) => text, save: (agentCwd) => set({ agentCwd }) })
  const roots = useFieldDraft(settings.fileRoots, {
    format: (folders) => folders.join('\n'),
    parse: (text) => text.split('\n').map((line) => line.trim()).filter(Boolean),
    save: (fileRoots) => set({ fileRoots })
  })
  const unavailable = status && status.agent !== 'found' ? { state: status.agent, engine: status.agentEngine } : null
  return (
    <Page title="Agent" lead={t('settingsAgent.lead')}>
      <Group title={t('settingsAgent.run.title')} description={t('settingsAgent.run.description')}>
        <Row label={t('settingsAgent.run.engine')} hint={settings.agentEngine === 'claude' ? t('settingsAgent.run.claudeKeyHint') : undefined}>
          {unavailable && <Chip tone="warn">{t(unavailable.state === 'missing' ? 'common.notFound' : 'common.notReady')}</Chip>}
          <select
            className="st-select"
            aria-label={t('settingsAgent.run.engineLabel')}
            value={settings.agentEngine}
            onChange={(e) => set({ agentEngine: e.target.value as 'codex' | 'claude' })}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </Row>
        {unavailable && (
          <PrepLine
            text={t(unavailable.state === 'missing' ? 'settingsAgent.run.engineMissing' : AGENT_CLI_UNAVAILABLE_TEXT[unavailable.state], { engine: unavailable.engine })}
          >
            <Btn onClick={() => void window.api.openExternal(AGENT_INSTALL_GUIDE[settings.agentEngine])}>
              <ExternalLink size={12} />
              {t('settingsModels.agent.install')}
            </Btn>
          </PrepLine>
        )}
        <Row label={t('settingsAgent.run.permissions')} hint={t('settingsAgent.run.permissionsHint', { ...AGENT_MODE_NAME[settings.agentEngine], engine: settings.agentEngine === 'codex' ? 'Codex' : 'Claude Code' })}>
          <select
            className="st-select"
            aria-label={t('settingsAgent.run.permissionsLabel')}
            value={settings.agentMode}
            onChange={(e) => set({ agentMode: e.target.value as 'readonly' | 'auto' })}
          >
            <option value="readonly">{AGENT_MODE_NAME[settings.agentEngine].readonly}</option>
            <option value="auto">{AGENT_MODE_NAME[settings.agentEngine].auto}</option>
          </select>
        </Row>
      </Group>

      <Group title={t('settingsAgent.workspace.title')} description={t('settingsAgent.workspace.description')}>
        <Row label={t('settingsAgent.workspace.parent')} hint={cwd.failed ? <NotSavedHint /> : undefined} wide>
          <div className="st-field-action">
            <input className="st-input is-mono" aria-label={t('settingsAgent.workspace.parentLabel')} {...cwd.props} />
            <Btn onClick={() => chooseFolder(cwd.value, (folder) => set({ agentCwd: folder }))}>{t('settingsAgent.workspace.choose')}</Btn>
          </div>
        </Row>
      </Group>

      <Group title={t('settingsAgent.roots.title')} description={t('settingsAgent.roots.description')}>
        <Row label={t('settingsAgent.roots.folders')} hint={roots.failed ? <NotSavedHint /> : undefined} wide>
          <textarea className="st-input is-mono st-roots" aria-label={t('settingsAgent.roots.title')} placeholder={t(osMessageKey('settingsAgent.roots.placeholder', platformCapabilities().os))} {...roots.props} />
          <div className="st-row-actions">
            <Btn
              onClick={() =>
                chooseFolder(undefined, (folder) => {
                  if (!roots.value.includes(folder)) set({ fileRoots: [...roots.value, folder] })
                })
              }
            >
              {t('settingsAgent.roots.add')}
            </Btn>
          </div>
        </Row>
      </Group>
    </Page>
  )
}
