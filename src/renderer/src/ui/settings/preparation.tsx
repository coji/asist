import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { HoloSwitch } from '@/components/ui/switch'
import { useT } from '@/i18n'
import type { PreparationTarget } from '@shared/ipc'
import { progressLabel } from '../progress-label'
import type { SettingsContext, StatusRead } from './context'
import { Btn, Chip, Progress } from './primitives'

/**
 * A preparation shown under the row that needs it: what is missing, the button that fetches it, and the
 * progress while it runs. Only one preparation runs at a time, so every button waits while one is busy.
 */
export function PrepLine({ text, children, progress }: { text: string; children: ReactNode; progress?: ReactNode }): React.JSX.Element {
  return (
    <div className="st-prepline">
      <CircleAlert size={14} aria-hidden />
      <span className="st-prepline-text">{text}</span>
      <div className="st-prepline-actions">{children}</div>
      {progress}
    </div>
  )
}

/** In place of the control of a row whose state main has not reported: that it is being checked, or that the check failed. */
export function UnreadChip({ status }: { status: StatusRead<unknown> }): React.JSX.Element {
  const t = useT()
  return status === null ? <Chip>{t('settingsModels.checking')}</Chip> : <Chip tone="warn">{t('settingsModels.checkFailed')}</Chip>
}

/** The button that starts one preparation, and the button that stops it where it can be stopped. */
export function PrepareButton({
  ctx,
  target,
  onClick,
  onCancel,
  label,
  tone = 'primary'
}: {
  ctx: SettingsContext
  target: PreparationTarget
  onClick: () => void
  onCancel?: () => void
  label?: string
  tone?: 'primary' | 'quiet'
}): React.JSX.Element {
  const t = useT()
  const { running } = ctx.prep
  const preparing = running?.target === target
  return (
    <>
      <Btn tone={tone} data-prep={target} disabled={running !== null} onClick={onClick}>
        {preparing ? t('common.preparing') : (label ?? t('settingsModels.prepare'))}
      </Btn>
      {preparing && onCancel && (
        <Btn tone="quiet" onClick={onCancel}>
          {t('common.stop')}
        </Btn>
      )}
    </>
  )
}

/** The progress of the preparation of `target`, or nothing while another one or none runs. */
export function PrepProgress({ ctx, target }: { ctx: SettingsContext; target: PreparationTarget }): React.JSX.Element | null {
  const { running } = ctx.prep
  if (running?.target !== target || !running.progress) return null
  return <Progress percent={running.progress.pct ?? 0} label={progressLabel(running.progress)} />
}

/**
 * Whisper in the browser: its switch once it is prepared, and until then the button that prepares it, or how
 * far it has come while it downloads inside the window.
 */
export function WhisperControl({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  const { settings, prep, prepare, set } = ctx
  if (settings.localAsrEnabled) return <HoloSwitch checked onCheckedChange={(value) => set({ localAsrEnabled: value })} />
  if (prep.localAsr === null) return <Btn onClick={prepare.localAsr}>{t('settingsModels.prepare')}</Btn>
  return (
    <>
      <span className="st-progress-label">{Math.round(prep.localAsr)}%</span>
      <Btn tone="quiet" onClick={prepare.cancelLocalAsr}>
        {t('common.stop')}
      </Btn>
    </>
  )
}
