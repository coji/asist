import { useEffect, useState } from 'react'
import type { MemoryOverview } from '@shared/ipc'
import { HoloSwitch } from '@/components/ui/switch'
import { useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import type { SettingsContext } from '../context'
import { useFieldDraft } from '@/ui/field-draft'
import { Btn, Chip, Group, Link, NotSavedHint, Page, Row } from '../primitives'
import { PrepProgress, PrepareButton } from '../preparation'
import { displayError, errorMessageOf } from '@/display-error'
import { useFormatLocale, useT } from '@/i18n'

/**
 * The memory page: semantic search, prepared from its own row, the curation of memories, how long the
 * conversation log it reads is kept, and a link to the memory view.
 */
export function MemoryPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, embedding, prepare, set } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const when = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  // Null until main answers, and then the overview or the message of the error it threw.
  const [overview, setOverview] = useState<{ read: MemoryOverview } | { error: string } | null>(null)
  const [curating, setCurating] = useState(false)
  const embeddingReady = embedding?.runtimeInstalled === true && embedding.modelInstalled
  const retention = useFieldDraft(settings.conversationLogRetentionDays, {
    format: String,
    parse: (text) => {
      const days = Number(text)
      return Number.isInteger(days) && days >= 1 ? days : null
    },
    save: (conversationLogRetentionDays) => set({ conversationLogRetentionDays })
  })

  const refresh = async (): Promise<void> => {
    try {
      setOverview({ read: await window.api.memoryOverview() })
    } catch (err) {
      setOverview({ error: errorMessageOf(err) })
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const curate = (): void => {
    setCurating(true)
    void window.api
      .memoryCurate()
      .then((job) => {
        toast(
          job
            ? { kind: 'ok', title: t('settingsMemory.curation.started'), body: t('settingsMemory.curation.startedBody', { title: job.title }) }
            : { kind: 'ok', title: t('settingsMemory.curation.nothingToCurate'), body: t('settingsMemory.curation.nothingToCurateBody') }
        )
        return refresh()
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('settingsMemory.curation.startFailed'), body: displayError(err) }))
      .finally(() => setCurating(false))
  }
  const read = overview && 'read' in overview ? overview.read : null
  const failure = read?.lastFailure ?? null
  // The overview fails as a whole when main cannot read the curation's state file, and the curation cannot
  // run until that file is fixed, so the status gives the reason rather than a state it does not know.
  const unavailable = overview && 'error' in overview ? displayError(overview.error) : (read?.unavailableReason ?? null)
  const curationHint = !overview
    ? t('settingsMemory.curation.checkingState')
    : unavailable
      ? unavailable
      : read?.pendingJobId
        ? t('settingsMemory.curation.pending')
        : failure
          ? t('settingsMemory.curation.failed', { when: when.format(failure.at), message: failure.message })
          : read?.curatedThrough
            ? t('settingsMemory.curation.curatedThrough', { date: read.curatedThrough })
            : t('settingsMemory.curation.neverRun')

  return (
    <Page title={t('settingsMemory.title')} lead={t('settingsMemory.lead')}>
      <Group title={t('settingsMemory.search.title')} description={t('settingsMemory.search.description')}>
        <Row
          label={t('settingsMemory.search.use')}
          hint={
            embeddingReady
              ? t(
                  embedding.converting
                    ? 'settingsMemory.search.converting'
                    : embedding.running
                      ? 'settingsMemory.search.convertedRunning'
                      : 'settingsMemory.search.converted',
                  { embedded: embedding.embedded, total: embedding.total }
                )
              : t('settingsMemory.search.notPrepared')
          }
        >
          {embedding === null ? (
            <Chip>{t('settingsModels.checking')}</Chip>
          ) : embeddingReady ? (
            <HoloSwitch checked={settings.memoryEmbeddingEnabled} onCheckedChange={(v) => set({ memoryEmbeddingEnabled: v })} />
          ) : (
            <PrepareButton ctx={ctx} target="embedding" onClick={prepare.embedding} label={t('settingsModels.prepareAndTurnOn')} />
          )}
        </Row>
        <PrepProgress ctx={ctx} target="embedding" />
      </Group>

      <Group
        title={t('settingsMemory.curation.title')}
        description={t('settingsMemory.curation.description')}
        action={
          <Btn tone="primary" disabled={curating || !overview || unavailable !== null} onClick={curate}>
            {curating ? t('settingsMemory.curation.starting') : t('settingsMemory.curation.start')}
          </Btn>
        }
      >
        <Row label={t('settingsMemory.curation.status')} hint={curationHint}>
          <Chip tone={unavailable || (failure && !read?.pendingJobId) ? 'warn' : read?.pendingJobId ? 'cyan' : 'dim'}>
            {!overview
              ? t('settingsMemory.curation.checking')
              : unavailable
                ? t('settingsMemory.curation.unavailable')
                : read?.pendingJobId
                  ? t('settingsMemory.curation.waiting')
                  : failure
                    ? t('settingsMemory.curation.failedChip')
                    : read?.curatedThrough
                      ? t('settingsMemory.curation.done')
                      : t('settingsMemory.curation.notRun')}
          </Chip>
        </Row>
      </Group>

      <Group title={t('settingsMemory.log.title')} description={t('settingsMemory.log.description')}>
        <Row label={t('settingsMemory.log.retention')} hint={retention.failed ? <NotSavedHint /> : t('settingsMemory.log.retentionHint')}>
          <input
            type="number"
            min={1}
            className="st-input is-mono"
            style={{ width: 88 }}
            aria-label={t('settingsMemory.log.retentionLabel')}
            {...retention.props}
          />
        </Row>
      </Group>

      <Group title={t('settingsMemory.view.title')} description={t('settingsMemory.view.description')}>
        <Row label={t('settingsMemory.view.dockHint')}>
          <Link onClick={() => useViewStore.getState().openApp({ app: 'memory' })}>{t('settingsMemory.view.open')}</Link>
        </Row>
      </Group>
    </Page>
  )
}
