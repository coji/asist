import { beforeEach, describe, expect, it, vi } from 'vitest'
import mitt from 'mitt'
import type { AppStatus, LiveAudio } from '@shared/ipc'

/**
 * The conversation driven by the events of the voice pipeline: the voice controller and the speech
 * player are replaced by emitters, and the stores by plain objects.
 */

const mocks = vi.hoisted(() => {
  const turn = {
    phase: 'idle' as string,
    /** Every phase set, in order, to tell a phase that only flickered past. */
    phases: [] as string[],
    partial: '',
    activeTurnId: -1,
    timings: {} as Record<string, unknown>,
    setPhase: (phase: string) => {
      turn.phase = phase
      turn.phases.push(phase)
    },
    setActiveTurn: (id: number) => {
      turn.activeTurnId = id
    },
    setTimings: (timings: Record<string, unknown>) => {
      turn.timings = timings
    },
    setPartial: (partial: string) => {
      turn.partial = partial
    },
    setRouterNote: () => {},
    setMic: () => {}
  }
  const settings: Record<string, unknown> = {}
  const lines: Array<{ id: number; role: string; text: string; turnId?: number; streaming?: boolean }> = []
  const feed = {
    lines,
    append: (line: Omit<(typeof lines)[number], 'id'>) => lines.push({ ...line, id: lines.length + 1 }),
    insertBefore: (_before: number, line: Omit<(typeof lines)[number], 'id'>) => feed.append(line),
    update: (id: number, patch: Partial<(typeof lines)[number]>) => Object.assign(lines.find((line) => line.id === id)!, patch),
    appendToText: (id: number, delta: string) => {
      lines.find((line) => line.id === id)!.text += delta
    }
  }
  return {
    turn,
    settings,
    feed,
    windows: false,
    playing: false,
    readingTurn: -1,
    /** When the player was last handed a sentence of an answer. */
    bodyQueuedAt: -Infinity,
    settingsListener: null as ((state: { settings: unknown }, before: { settings: unknown }) => void) | null,
    player: null as unknown,
    voice: null as unknown,
    live: null as unknown,
    realLive: null as object | null,
    /** The requests the conversation put on the confirmation sheet. */
    confirmOpened: [] as unknown[],
    /** The toasts the conversation raised. */
    toasts: [] as unknown[],
    /** The app's own status store, loaded afresh for each test. */
    status: null as null | typeof import('../src/renderer/src/state/stores').useStatusStore
  }
})

const baseSettings = {
  aizuchi: true,
  aizuchiRate: 1,
  bridgePhrase: true,
  ttsEngine: 'voicevox',
  conversationLocale: 'ja-JP',
  voiceEngine: 'cascade',
  micAutoStart: false,
  onboardingVersion: 1,
  safetyNoticeVersion: 1,
  bargeIn: true,
  listeningAizuchi: true,
  partialIntervalMs: 600,
  localAsrEnabled: false,
  nativeMic: true,
  noiseSuppression: true,
  vapEnabled: false,
  hangoverMs: 350,
  liveIdleSeconds: 60,
  geminiLive: { model: 'gemini-live', voice: 'Puck' }
}

vi.mock('@/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS), loadPlatformCapabilities: async () => {} }
})
vi.mock('@/voice/VoiceController', async () => {
  const { default: mittFactory } = await import('mitt')
  const voiceController = {
    current: 'listening',
    msSinceBackchannel: Infinity,
    events: mittFactory(),
    handleAsrStatus: vi.fn(),
    recover: async () => {},
    setHangover: () => {},
    enable: vi.fn(async () => {}),
    disable: vi.fn()
  }
  mocks.voice = voiceController
  return { voiceController }
})
vi.mock('@/voice/LiveVoice', async () => {
  const { default: mittFactory } = await import('mitt')
  const liveVoice = { current: 'off', events: mittFactory(), recover: async () => {}, enable: vi.fn(async () => {}), disable: vi.fn() }
  mocks.live = liveVoice
  // A test that puts a real LiveVoice in mocks.realLive has the conversation it starts use that one instead.
  const source = (): object => mocks.realLive ?? liveVoice
  return {
    liveVoice: new Proxy(liveVoice, {
      get: (_target, key) => {
        const value: unknown = Reflect.get(source(), key)
        return typeof value === 'function' ? value.bind(source()) : value
      },
      set: (_target, key, value) => Reflect.set(source(), key, value)
    })
  }
})
vi.mock('@/voice/SpeechPlayer', async () => {
  const { default: mittFactory } = await import('mitt')
  const speechPlayer = {
    events: mittFactory(),
    get isPlaying() {
      return mocks.playing
    },
    get readingTurn() {
      return mocks.readingTurn
    },
    isStreaming: false,
    playClip: vi.fn((audio: string | null, text: string, options: { role: string }) => {
      mocks.playing = true
      return { turnId: -1, index: -1, text, audio, phonemes: null, clip: options.role }
    }),
    discardBody: vi.fn(),
    dropWaiting: vi.fn(),
    beginTurn: vi.fn(),
    enqueue: vi.fn(),
    interrupt: vi.fn(),
    bodyQueuedAfter: (time: number) => mocks.bodyQueuedAt > time,
    recover: () => {},
    streamPush: () => {},
    streamClear: () => {},
    pushSegmentAudio: () => {}
  }
  mocks.player = speechPlayer
  return { speechPlayer }
})
vi.mock('@/voice/aizuchi-bank', () => ({
  loadAizuchiBank: vi.fn(async () => {}),
  pickAizuchi: vi.fn((_classification: unknown, policy: { enabled: boolean }) =>
    policy.enabled ? { text: 'はい。', category: 'flow', weight: 1, audio: 'eA==' } : null
  ),
  pickListeningClip: vi.fn(() => ({ text: 'うん', audio: 'eA==' }))
}))
vi.mock('@/i18n', () => ({ translate: (key: string) => key, uiLocale: () => 'ja-JP' }))
vi.mock('@/state/confirm', () => ({
  useConfirmStore: {
    getState: () => ({
      queue: mocks.confirmOpened,
      open: (request: unknown) => mocks.confirmOpened.push(request),
      close: (id: string) => {
        mocks.confirmOpened = mocks.confirmOpened.filter((request) => (request as { id: string }).id !== id)
      }
    })
  }
}))
vi.mock('@/state/view', () => ({
  startMiniAppReports: () => {},
  useViewStore: { getState: () => ({ openApp: () => {}, closeApp: () => {} }) }
}))
vi.mock('@/state/stores', () => {
  const plain = (extra: Record<string, unknown> = {}) => ({
    getState: () => ({
      load: async () => {},
      apply: () => {},
      push: () => {},
      reset: () => {},
      refresh: async () => {},
      loadDrafts: async () => {},
      dismissLoadingOwnedBy: () => {},
      panels: [],
      jobs: [],
      ...extra
    })
  })
  return {
    useTurnStore: { getState: () => mocks.turn },
    useFeedStore: { getState: () => mocks.feed },
    useJobStore: plain(),
    useLiveStore: plain(),
    usePanelStore: plain(),
    useSettingsStore: {
      getState: () => ({ settings: mocks.settings, load: async () => {} }),
      subscribe: (listener: typeof mocks.settingsListener) => {
        mocks.settingsListener = listener
        return () => {}
      }
    },
    useStatusStore: {
      getState: () => mocks.status!.getState(),
      subscribe: (...args: Parameters<NonNullable<typeof mocks.status>['subscribe']>) => mocks.status!.subscribe(...args)
    },
    useToastStore: plain({ push: (toast: unknown) => mocks.toasts.push(toast) }),
    useTaskStore: plain(),
    useNoteStore: plain(),
    useMailStore: plain()
  }
})

type Emitter = ReturnType<typeof mitt>
type Mock = ReturnType<typeof vi.fn>

const voice = (): { events: Emitter; enable: Mock; disable: Mock; current: string } =>
  mocks.voice as { events: Emitter; enable: Mock; disable: Mock; current: string }
const player = (): { events: Emitter; playClip: Mock; beginTurn: Mock; dropWaiting: Mock } =>
  mocks.player as { events: Emitter; playClip: Mock; beginTurn: Mock; dropWaiting: Mock }

function api(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => () => {}
      if (key === 'getStatus') return async () => ({ sequence: 1, asr: true, tts: true })
      if (key === 'confirmPending') return async () => []
      if (key === 'aizuchiClassifierStatus') return async () => ({ runtimeInstalled: true, modelInstalled: true, running: true })
      return async () => undefined
    }
  })
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** The speech end the VAD decides, 350 ms of hangover after the voice stopped. */
function speechEnd(startedAt: number, partialText = ''): { startedAt: number; speechEndAt: number; vadMs: number } {
  const now = performance.now()
  voice().events.emit('speechend', {
    startedAt,
    speechEndAt: now - 350,
    vadMs: 350,
    vadMode: 'fixed',
    partialText,
    utteranceMs: now - 350 - startedAt,
    listening: []
  })
  return { startedAt, speechEndAt: now - 350, vadMs: 350 }
}

function utterance(end: { startedAt: number; speechEndAt: number; vadMs: number }, text: string): void {
  voice().events.emit('utterance', { text, vadMode: 'fixed', asrMs: 400, partialText: '', ...end })
}

/** The clip the conversation handed to the player last, such as the opening "はい。" a speech end plays. */
const lastClip = (): Record<string, unknown> => player().playClip.mock.results.at(-1)!.value as Record<string, unknown>

/** The player starts sounding a segment it was handed. */
function sound(segment: Record<string, unknown>, durationMs: number): void {
  player().events.emit('segmentstart', { segment, durationMs })
}

/** The rows of measurements saved, in order. */
const savedRows = (metricsLog: Mock): Array<Record<string, unknown>> =>
  metricsLog.mock.calls.map((call) => (call as Array<Record<string, unknown>>)[0])

/** A whole utterance: speech end, which plays the opening "はい。", then the final transcript. */
function speak(text: string): void {
  utterance(speechEnd(performance.now() - 2500), text)
}

async function start(overrides: Record<string, unknown>): Promise<typeof import('@/conversation')> {
  vi.stubGlobal('window', { addEventListener: () => {}, api: api(overrides) })
  const conversation = await import('@/conversation')
  await conversation.initConversation()
  return conversation
}

beforeEach(async () => {
  vi.resetModules()
  mocks.status = (await vi.importActual<typeof import('../src/renderer/src/state/stores')>('../src/renderer/src/state/stores')).useStatusStore
  mocks.toasts = []
  mocks.playing = false
  mocks.readingTurn = -1
  mocks.bodyQueuedAt = -Infinity
  mocks.turn.phase = 'idle'
  mocks.turn.phases = []
  mocks.turn.partial = ''
  mocks.turn.activeTurnId = -1
  mocks.turn.timings = {}
  mocks.confirmOpened = []
  mocks.realLive = null
  mocks.feed.lines.length = 0
  for (const key of Object.keys(mocks.settings)) delete mocks.settings[key]
  Object.assign(mocks.settings, structuredClone(baseSettings))
  // The mocked modules survive resetModules, so the listeners of the previous test's conversation go.
  ;(mocks.voice as { events: Emitter } | null)?.events.all.clear()
  ;(mocks.player as { events: Emitter } | null)?.events.all.clear()
  vi.clearAllMocks()
  vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' })
})

describe('the native microphone', () => {
  it('is tried only on a machine that has one, whatever the setting says', async () => {
    const preferred = (): unknown[] => [mocks.voice, mocks.live].map((source) => (source as { nativeMicPreferred?: boolean }).nativeMicPreferred)
    await start({})
    expect(preferred()).toEqual([true, true])
    mocks.windows = true
    try {
      vi.resetModules()
      await start({})
      expect(preferred()).toEqual([false, false])
    } finally {
      mocks.windows = false
    }
  })
})

describe('the microphone set to turn on at launch', () => {
  it('turns on for the first page the app shows', async () => {
    mocks.settings.micAutoStart = true
    await start({ isLaunchPage: async () => true })
    expect(voice().enable).toHaveBeenCalled()
  })

  it('stays off on a page loaded again after a reload or a crash', async () => {
    mocks.settings.micAutoStart = true
    await start({ isLaunchPage: async () => false })
    expect(voice().enable).not.toHaveBeenCalled()
  })
})

describe('the aizuchi classifier', () => {
  it('is asked about each partial recognition on Windows as on a Mac', async () => {
    const classifiedOn = async (windows: boolean): Promise<number> => {
      mocks.windows = windows
      vi.resetModules()
      const aizuchiClassify = vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 }))
      await start({ aizuchiClassify })
      voice().events.emit('state', 'capturing')
      voice().events.emit('partial', '昨日の会議の件なんですけど')
      await flush()
      return aizuchiClassify.mock.calls.length
    }
    try {
      expect(await classifiedOn(false)).toBeGreaterThan(0)
      expect(await classifiedOn(true)).toBeGreaterThan(0)
    } finally {
      mocks.windows = false
    }
  })
})

describe('the aizuchi bank', () => {
  it('is loaded again when main reports a new bank, and a change of the voice settings alone leaves it to main', async () => {
    let bankChanged!: () => void
    await start({
      onAizuchiBankChanged: (callback: () => void) => {
        bankChanged = callback
        return () => {}
      }
    })
    const { loadAizuchiBank } = await import('@/voice/aizuchi-bank')
    const loads = (): number => vi.mocked(loadAizuchiBank).mock.calls.length
    expect(loads()).toBe(1)

    const before = structuredClone(mocks.settings)
    mocks.settingsListener!({ settings: { ...before, ttsEngine: 'aivisspeech', conversationLocale: 'en-US' } }, { settings: before })
    expect(loads()).toBe(1)

    bankChanged()
    expect(loads()).toBe(2)
  })
})

describe('the opening of a speech that never becomes a turn', () => {
  it('does not play the bridge once the speech is reported dropped', async () => {
    let synthesized!: (clip: { text: string; audio: string }) => void
    await start({
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(async () => ({ bridge: '会議の件ですね。' })),
      bridgeSynthesize: vi.fn(() => new Promise((resolve) => (synthesized = resolve)))
    })

    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '昨日の会議の件なんですけど')
    await flush()
    const { startedAt } = speechEnd(performance.now() - 3000, '昨日の会議の件なんですけど')
    await flush()
    // The final transcription fails while the bridge is being synthesized.
    voice().events.emit('speechdropped', { startedAt })
    synthesized({ text: '会議の件ですね。', audio: 'eA==' })
    await flush()

    const roles = player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)
    expect(roles).toContain('aizuchi')
    expect(roles).not.toContain('bridge')
  })
})

describe('the bridge of a turn that goes wrong', () => {
  let synthesized!: (clip: { text: string; audio: string }) => void

  async function speakUntilTheBridgeIsSynthesized(): Promise<typeof import('@/conversation')> {
    const conversation = await start({
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(async () => ({ bridge: '会議の件ですね。' })),
      bridgeSynthesize: vi.fn(() => new Promise((resolve) => (synthesized = resolve))),
      turnStart: vi.fn(async () => 42)
    })
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '昨日の会議の件なんですけど')
    await flush()
    const end = speechEnd(performance.now() - 3000, '昨日の会議の件なんですけど')
    await flush()
    utterance(end, '昨日の会議の件なんですけど')
    await flush()
    return conversation
  }
  const playedRoles = (): string[] =>
    player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)

  it('is not played once the turn ended without saying anything, though its synthesis finishes afterwards', async () => {
    const conversation = await speakUntilTheBridgeIsSynthesized()
    // Brain fails before it says anything, for instance while it prepares the request.
    conversation.handleTurnEvent({ type: 'error', turnId: 42, message: 'no key' })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '' })
    synthesized({ text: '会議の件ですね。', audio: 'eA==' })
    await flush()
    expect(playedRoles()).toContain('aizuchi')
    expect(playedRoles()).not.toContain('bridge')
  })

  it('is still played when one sentence of the reply failed to be synthesized and the rest goes on', async () => {
    const conversation = await speakUntilTheBridgeIsSynthesized()
    conversation.handleTurnEvent({ type: 'error', turnId: 42, message: 'VOICEVOX is not running' })
    synthesized({ text: '会議の件ですね。', audio: 'eA==' })
    await flush()
    expect(playedRoles()).toContain('bridge')
  })
})

describe('the bridge and what brain is told of it', () => {
  const playedRoles = (): string[] =>
    player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)
  const startOptions = (turnStart: Mock): { bridge?: string; bridgePending?: boolean } =>
    (turnStart.mock.calls[0] as unknown[])[1] as { bridge?: string; bridgePending?: boolean }

  /** Speaks one utterance whose look-ahead answers only when `planned` is called, after the final transcript. */
  async function speakAheadOfTheLookahead(
    words: { partial: string; final: string },
    overrides: Record<string, unknown> = {}
  ): Promise<{ turnStart: Mock; bridgeSynthesize: Mock; planned: (plan: { bridge: string }) => void }> {
    let planned!: (plan: { bridge: string }) => void
    const turnStart = vi.fn(async () => 42)
    const bridgeSynthesize = vi.fn(async (text: string) => ({ text, audio: 'eA==' }))
    await start({
      bridgePlan: vi.fn(() => new Promise((resolve) => (planned = resolve))),
      bridgeSynthesize,
      turnStart,
      ...overrides
    })
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', words.partial)
    await flush()
    utterance(speechEnd(performance.now() - 3000, words.partial), words.final)
    await flush()
    return { turnStart, bridgeSynthesize, planned: (plan) => planned(plan) }
  }

  it('plays in a language with no aizuchi classifier, decided by the look-ahead alone', async () => {
    mocks.settings.conversationLocale = 'en-US'
    const bridgeSynthesize = vi.fn(async (text: string) => ({ text, audio: 'eA==' }))
    const turnStart = vi.fn(async () => 42)
    await start({ bridgePlan: vi.fn(async () => ({ bridge: "Tomorrow's weather, right." })), bridgeSynthesize, turnStart })

    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', 'what is the weather tomorrow')
    await flush()
    const end = speechEnd(performance.now() - 3000, 'what is the weather tomorrow')
    await flush()
    utterance(end, 'What is the weather tomorrow?')
    await flush()

    expect(bridgeSynthesize).toHaveBeenCalledWith("Tomorrow's weather, right.")
    expect(playedRoles()).toContain('bridge')
    expect(startOptions(turnStart).bridge).toBe("Tomorrow's weather, right.")
  })

  it('is neither announced nor played in a language with no classifier when the look-ahead has not answered by the final transcript', async () => {
    mocks.settings.conversationLocale = 'en-US'
    const { turnStart, bridgeSynthesize, planned } = await speakAheadOfTheLookahead({
      partial: 'no I meant Tuesday not Thursday',
      final: 'No, I meant Tuesday, not Thursday.'
    })
    expect(startOptions(turnStart).bridgePending).toBeUndefined()

    planned({ bridge: 'Tuesday, then.' })
    await flush()

    expect(bridgeSynthesize).not.toHaveBeenCalled()
    expect(playedRoles()).not.toContain('bridge')
  })

  it('is announced as coming for a Japanese utterance the classifier lets have one, and plays once the look-ahead answers', async () => {
    const { turnStart, planned } = await speakAheadOfTheLookahead(
      { partial: '昨日の会議の件なんですけど', final: '昨日の会議の件なんですけど' },
      { aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })) }
    )
    expect(startOptions(turnStart).bridgePending).toBe(true)

    planned({ bridge: '会議の件ですね。' })
    await flush()

    expect(playedRoles()).toContain('bridge')
  })

  it('is decided by the look-ahead alone for a Japanese utterance while the classifier does not run', async () => {
    const aizuchiClassify = vi.fn(async () => {
      throw new Error('the classifier is not running')
    })
    const bridgeSynthesize = vi.fn(async (text: string) => ({ text, audio: 'eA==' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start({
      aizuchiClassifierStatus: async () => ({ runtimeInstalled: false, modelInstalled: false, running: false }),
      aizuchiClassify,
      bridgePlan: vi.fn(async () => ({ bridge: '明日の天気ですね。' })),
      bridgeSynthesize,
      turnStart: vi.fn(async () => 42)
    })

    voice().events.emit('state', 'capturing')
    await flush()
    voice().events.emit('partial', '明日の天気を教えて')
    await flush()
    const end = speechEnd(performance.now() - 3000, '明日の天気を教えて')
    await flush()
    utterance(end, '明日の天気を教えて')
    await flush()

    expect(bridgeSynthesize).toHaveBeenCalledWith('明日の天気ですね。')
    expect(playedRoles()).toContain('bridge')
    expect(aizuchiClassify).not.toHaveBeenCalled()
    vi.mocked(console.warn).mockRestore()
  })

  describe('when a new capture opens before the look-ahead answers', () => {
    let planned!: (plan: { bridge: string }) => void
    const meeting = '昨日の会議の件なんですけど'

    /** Ends a Japanese utterance the classifier lets have a bridge, opens the next capture, and lets the look-ahead answer then. */
    async function speakThenCaptureAgain(): Promise<{ first: ReturnType<typeof speechEnd>; turnStart: Mock }> {
      const turnStart = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)
      await start({
        aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
        bridgePlan: vi.fn(() => new Promise((resolve) => (planned = resolve))),
        bridgeSynthesize: vi.fn(async (text: string) => ({ text, audio: 'eA==' })),
        turnStart
      })
      voice().events.emit('state', 'capturing')
      voice().events.emit('partial', meeting)
      await flush()
      const first = speechEnd(performance.now() - 3000, meeting)
      sound(lastClip(), 400)
      mocks.playing = false
      player().events.emit('idle', { turnId: -1 })
      // The user goes on once the aizuchi has ended.
      voice().events.emit('state', 'capturing')
      utterance(first, meeting)
      await flush()
      planned({ bridge: '会議の件ですね。' })
      await flush()
      // Nothing sounds over the capture that is open.
      expect(playedRoles()).not.toContain('bridge')
      return { first, turnStart }
    }

    it('plays once that capture ends without speech', async () => {
      await speakThenCaptureAgain()
      voice().events.emit('state', 'listening')
      await flush()

      expect(playedRoles()).toContain('bridge')
    })

    it('plays once that capture ends in speech that yields no turn', async () => {
      await speakThenCaptureAgain()
      const echo = speechEnd(performance.now() - 300)
      voice().events.emit('state', 'transcribing')
      await flush()
      expect(playedRoles()).not.toContain('bridge')
      utterance(echo, 'はい')
      await flush()

      expect(playedRoles()).toContain('bridge')
    })

    it('is dropped once the user, who went on speaking, has said something that becomes a turn', async () => {
      const { turnStart } = await speakThenCaptureAgain()
      voice().events.emit('partial', '予算の話をしたいです')
      const second = speechEnd(performance.now() - 1500, '予算の話をしたいです')
      voice().events.emit('state', 'transcribing')
      utterance(second, '予算の話をしたいです')
      voice().events.emit('state', 'listening')
      await flush()

      expect(turnStart).toHaveBeenCalledTimes(2)
      expect(playedRoles()).not.toContain('bridge')
    })
  })

  it('plays as queued behind the opening aizuchi when the echo of that aizuchi opens a capture and the answer arrives while the echo is transcribed', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    let planned!: (plan: { bridge: string }) => void
    const turnStart = vi.fn(async () => 42)
    const conversation = await start({
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(() => new Promise((resolve) => (planned = resolve))),
      bridgeSynthesize: vi.fn(async (text: string) => ({ text, audio: 'eA==' })),
      turnStart,
      metricsLog
    })
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '昨日の会議の件なんですけど')
    await flush()
    const first = speechEnd(performance.now() - 3000, '昨日の会議の件なんですけど')
    voice().events.emit('state', 'transcribing')
    const aizuchi = lastClip()
    planned({ bridge: '会議の件ですね。' })
    await flush()
    const bridge = lastClip()
    sound(aizuchi, 600)
    // The echo of the aizuchi opens a capture while the bridge waits behind it.
    voice().events.emit('state', 'capturing')
    utterance(first, '昨日の会議の件なんですけど')
    await flush()
    const echo = speechEnd(performance.now() - 100)
    voice().events.emit('state', 'transcribing')
    // The answer's first sentence is queued while the echo is transcribed.
    mocks.bodyQueuedAt = performance.now()
    utterance(echo, 'はい')
    await flush()
    voice().events.emit('state', 'listening')
    sound(bridge, 700)
    conversation.handleTurnEvent({ type: 'metrics', turnId: 42, timings: { ttftMs: 800 } })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: 'その件は予算の話でした。' })

    expect(startOptions(turnStart).bridge).toBe('会議の件ですね。')
    expect(player().dropWaiting).not.toHaveBeenCalled()
    expect(savedRows(metricsLog).at(-1)).toMatchObject({ bridge: 'played' })
  })

  it('is not played before the reply to a message typed right after the utterance it was made for', async () => {
    mocks.settings.conversationLocale = 'en-US'
    let synthesized!: (clip: { text: string; audio: string }) => void
    const turnStart = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    const conversation = await start({
      bridgePlan: vi.fn(async () => ({ bridge: "Tomorrow's weather, right." })),
      bridgeSynthesize: vi.fn(() => new Promise((resolve) => (synthesized = resolve))),
      turnStart
    })
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', 'what is the weather tomorrow')
    await flush()
    const end = speechEnd(performance.now() - 3000, 'what is the weather tomorrow')
    await flush()
    utterance(end, 'What is the weather tomorrow?')
    await flush()

    await conversation.sendTypedMessage('Actually, set a timer for five minutes')
    synthesized({ text: "Tomorrow's weather, right.", audio: 'eA==' })
    await flush()

    expect(turnStart).toHaveBeenCalledTimes(2)
    expect(playedRoles()).not.toContain('bridge')
  })

  for (const cls of ['flow', 'correct', 'hold', 'none', null] as const) {
    it(`is neither announced nor played for a Japanese utterance classified as ${cls ?? 'nothing yet'}`, async () => {
      const aizuchiClassify = vi.fn(() => (cls ? Promise.resolve({ cls, prob: 0.9, complete: 0.9 }) : new Promise(() => {})))
      const { turnStart, bridgeSynthesize, planned } = await speakAheadOfTheLookahead(
        { partial: '明日の天気を教えて', final: '明日の天気を教えて' },
        { aizuchiClassify }
      )
      expect(startOptions(turnStart).bridgePending).toBeUndefined()

      planned({ bridge: '明日の天気ですね。' })
      await flush()

      expect(bridgeSynthesize).not.toHaveBeenCalled()
      expect(playedRoles()).not.toContain('bridge')
    })
  }
})

describe('the aizuchi and the bridge phrase, each turned on and off by its own switch', () => {
  const playedRoles = (): string[] =>
    player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)
  const startOptions = (turnStart: Mock): { aizuchi?: string; bridge?: string; bridgePending?: boolean } =>
    (turnStart.mock.calls[0] as unknown[])[1] as { aizuchi?: string; bridge?: string; bridgePending?: boolean }

  /** Speaks one utterance through to its turn, with a classifier and a look-ahead that answer at once. */
  async function speakOnce(
    words: { partial: string; final: string },
    phrase: string,
    overrides: Record<string, unknown> = {}
  ): Promise<Record<'aizuchiClassify' | 'bridgePlan' | 'bridgeSynthesize' | 'turnStart', Mock>> {
    const asked = {
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(async () => ({ bridge: phrase })),
      bridgeSynthesize: vi.fn(async (text: string) => ({ text, audio: 'eA==' })),
      turnStart: vi.fn(async () => 42)
    }
    await start({ ...asked, ...overrides })
    voice().events.emit('state', 'capturing')
    await flush()
    voice().events.emit('partial', words.partial)
    await flush()
    const end = speechEnd(performance.now() - 3000, words.partial)
    await flush()
    utterance(end, words.final)
    await flush()
    return asked
  }
  const japanese = { partial: '昨日の会議の件なんですけど', final: '昨日の会議の件なんですけど' }
  const english = { partial: 'what is the weather tomorrow', final: 'What is the weather tomorrow?' }

  it('plays the aizuchi in Japanese with the bridge phrase off, and never asks the look-ahead or the speech for a phrase', async () => {
    mocks.settings.bridgePhrase = false
    const { aizuchiClassify, bridgePlan, bridgeSynthesize, turnStart } = await speakOnce(japanese, '会議の件ですね。')

    expect(aizuchiClassify).toHaveBeenCalled()
    expect(playedRoles()).toEqual(['aizuchi'])
    expect(bridgePlan).not.toHaveBeenCalled()
    expect(bridgeSynthesize).not.toHaveBeenCalled()
    expect(startOptions(turnStart)).toMatchObject({ aizuchi: 'はい。' })
    expect(startOptions(turnStart).bridge).toBeUndefined()
    expect(startOptions(turnStart).bridgePending).toBeUndefined()
  })

  it('plays the bridge phrase in Japanese with the aizuchi off, and never asks the classifier', async () => {
    mocks.settings.aizuchi = false
    const { aizuchiClassify, bridgePlan, bridgeSynthesize, turnStart } = await speakOnce(japanese, '会議の件ですね。')

    expect(aizuchiClassify).not.toHaveBeenCalled()
    expect(bridgePlan).toHaveBeenCalled()
    expect(bridgeSynthesize).toHaveBeenCalledWith('会議の件ですね。')
    expect(playedRoles()).toEqual(['bridge'])
    expect(startOptions(turnStart).aizuchi).toBeUndefined()
    expect(startOptions(turnStart).bridge).toBe('会議の件ですね。')
  })

  it('says nothing before the reply in English with the bridge phrase off, though the hidden aizuchi switch is on', async () => {
    mocks.settings.conversationLocale = 'en-US'
    mocks.settings.bridgePhrase = false
    const { aizuchiClassify, bridgePlan, bridgeSynthesize, turnStart } = await speakOnce(english, "Tomorrow's weather, right.")

    expect(aizuchiClassify).not.toHaveBeenCalled()
    expect(bridgePlan).not.toHaveBeenCalled()
    expect(bridgeSynthesize).not.toHaveBeenCalled()
    expect(playedRoles()).not.toContain('bridge')
    expect(startOptions(turnStart).bridge).toBeUndefined()
  })

  it('plays the bridge phrase in English with the bridge phrase on, though the hidden aizuchi switch is off', async () => {
    mocks.settings.conversationLocale = 'en-US'
    mocks.settings.aizuchi = false
    const { bridgeSynthesize, turnStart } = await speakOnce(english, "Tomorrow's weather, right.")

    expect(bridgeSynthesize).toHaveBeenCalledWith("Tomorrow's weather, right.")
    expect(playedRoles()).toEqual(['bridge'])
    expect(startOptions(turnStart).bridge).toBe("Tomorrow's weather, right.")
  })

  it.each([
    ['a Japanese conversation with the aizuchi on', {}, {}, true],
    ['a Japanese conversation with the aizuchi off', { aizuchi: false }, {}, false],
    [
      'a Japanese conversation whose classifier does not run',
      {},
      { aizuchiClassifierStatus: async () => ({ runtimeInstalled: false, modelInstalled: false, running: false }) },
      false
    ],
    ['an English conversation', { conversationLocale: 'en-US' }, {}, false]
  ] as const)('tells the look-ahead whether an aizuchi can go before the phrase, in %s', async (_case, settings, api, afterAizuchi) => {
    Object.assign(mocks.settings, settings)
    const { bridgePlan } = await speakOnce(japanese, '会議の件ですね。', api)

    expect(bridgePlan).toHaveBeenCalled()
    for (const [input] of bridgePlan.mock.calls as Array<[{ afterAizuchi?: boolean }]>) expect(input.afterAizuchi).toBe(afterAizuchi)
  })

  it('says nothing before the reply with both switches on when there is no voice to say it in', async () => {
    mocks.settings.ttsEngine = 'none'
    const { aizuchiClassify, bridgePlan, bridgeSynthesize } = await speakOnce(japanese, '会議の件ですね。')

    expect(aizuchiClassify).not.toHaveBeenCalled()
    expect(bridgePlan).not.toHaveBeenCalled()
    expect(bridgeSynthesize).not.toHaveBeenCalled()
  })
})

describe('echo of what the speaker played', () => {
  const question = { turnId: 5, index: 0, text: 'クラシックとジャズ、どちらを再生しますか？', audio: 'eA==', phonemes: null }
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('lets the user answer with one of the options once the question has finished', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    player().events.emit('segmentstart', { segment: question, durationMs: 2500 })
    player().events.emit('idle', { turnId: 5 })
    // The user starts speaking after the echo of the question has died away.
    await wait(300)
    const startedAt = performance.now()
    await wait(30)
    utterance(speechEnd(startedAt), 'クラシック')
    await flush()

    expect(turnStart).toHaveBeenCalledOnce()
    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('クラシック')
  })

  it('lets the user repeat a sentence that ended before the capture, while the next sentence still waits out the pause', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    const sentence = { turnId: 5, index: 0, text: '明日の東京は晴れで、最高気温は28度です。', audio: 'eA==', phonemes: null }
    player().events.emit('segmentstart', { segment: sentence, durationMs: 3000 })
    player().events.emit('segmentend', { segment: sentence })
    // The user speaks in the pause before the next sentence, once the echo of this one has died away.
    await wait(300)
    const startedAt = performance.now()
    await wait(30)
    utterance(speechEnd(startedAt), '最高気温は28度ですか')
    await flush()

    expect(turnStart).toHaveBeenCalledOnce()
  })

  it('drops the same words when they were captured while the question was playing', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    const startedAt = performance.now()
    player().events.emit('segmentstart', { segment: question, durationMs: 2500 })
    await wait(30)
    utterance(speechEnd(startedAt), 'クラシック')
    await flush()

    expect(turnStart).not.toHaveBeenCalled()
  })

  it('keeps a word the user said when the only aizuchi clip saying it started after the capture ended', async () => {
    const turnStart = vi.fn(async () => 7)
    await start({ turnStart })
    const end = speechEnd(performance.now() - 2500)
    // The opening aizuchi that speech end queued starts sounding once it is decoded.
    await wait(5)
    player().events.emit('segmentstart', {
      segment: { turnId: -1, index: -1, text: 'はい。', audio: 'eA==', phonemes: null, clip: 'aizuchi' },
      durationMs: 400
    })
    utterance(end, 'はい、それでお願いします。')
    await flush()

    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('はい、それでお願いします。')
  })

  it('strips a listening aizuchi that sounded during the capture off the end of the transcript', async () => {
    const turnStart = vi.fn(async () => 7)
    await start({ turnStart })
    const startedAt = performance.now()
    voice().events.emit('backchannel', { kind: 'continuer', source: 'text' })
    const [audio, text] = player().playClip.mock.calls[0] as [string, string]
    player().events.emit('segmentstart', {
      segment: { turnId: -1, index: -1, text, audio, phonemes: null, clip: 'listening' },
      durationMs: 300
    })
    await wait(5)
    utterance(speechEnd(startedAt), '昨日の資料なんですけど、うん。')
    await flush()

    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('昨日の資料なんですけど')
  })

  it('keeps the words a transcript starts with when the aizuchi saying them sounded only at a break inside the speech', async () => {
    const { pickListeningClip } = await import('@/voice/aizuchi-bank')
    vi.mocked(pickListeningClip).mockReturnValueOnce({ text: 'なるほど。', category: 'understand', weight: 1, audio: 'eA==' })
    const turnStart = vi.fn(async () => 7)
    await start({ turnStart })
    const startedAt = performance.now()
    await wait(5)
    // A break in the long utterance gets a listening aizuchi, and the user goes on speaking after it.
    voice().events.emit('backchannel', { kind: 'assessment', source: 'text' })
    const [audio, text] = player().playClip.mock.calls[0] as [string, string]
    const clip = { turnId: -1, index: -1, text, audio, phonemes: null, clip: 'listening' }
    player().events.emit('segmentstart', { segment: clip, durationMs: 500 })
    player().events.emit('idle', { turnId: -1 })
    const clipEnded = performance.now()
    utterance({ startedAt, speechEndAt: clipEnded + 2000, vadMs: 350 }, 'なるほどね、それで明日の会議の資料を用意しておいて')
    await flush()

    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('なるほどね、それで明日の会議の資料を用意しておいて')
  })
})

describe('a barge-in', () => {
  it('aborts the turn whose request was still waiting for its id instead of reading its reply', async () => {
    let answer!: (turnId: number) => void
    const turnStart = vi.fn(() => new Promise<number>((resolve) => (answer = resolve)))
    const turnAbort = vi.fn(async () => {})
    await start({ turnStart, turnAbort })

    speak('明日の天気を教えて')
    await flush()
    // The user carries on over the opening "はい。", and the voice controller confirms a barge-in.
    voice().events.emit('bargein', undefined)
    answer(42)
    await flush()

    expect(turnAbort).toHaveBeenCalledWith(42)
    expect(player().beginTurn).not.toHaveBeenCalledWith(42, expect.anything())
    expect(mocks.turn.activeTurnId).toBe(-1)
  })

  it('keeps the words of an utterance the user talked over while the turn before it was being stopped', async () => {
    let previousAborted!: () => void
    const turnAbort = vi.fn((turnId: number) => (turnId === 41 ? new Promise<void>((resolve) => (previousAborted = resolve)) : Promise.resolve()))
    const turnStart = vi.fn().mockResolvedValueOnce(41).mockResolvedValueOnce(42)
    await start({ turnStart, turnAbort })
    speak('明日の天気を教えて')
    await flush()

    speak('やっぱり明後日で')
    // The user carries on over the opening "はい。" of the new utterance before turn 41 is stopped.
    voice().events.emit('bargein', undefined)
    previousAborted?.()
    await flush()

    expect(mocks.feed.lines.filter((line) => line.role === 'user').map((line) => line.text)).toEqual(['明日の天気を教えて', 'やっぱり明後日で'])
    expect(turnStart).toHaveBeenLastCalledWith('やっぱり明後日で', expect.anything())
    // Its reply is not read, as for any request the user talked over.
    expect(turnAbort).toHaveBeenCalledWith(42)
    expect(player().beginTurn).not.toHaveBeenCalledWith(42, expect.anything())
  })

  it('is counted against a reply that is still being read after brain reported it done', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    speak('明日の天気を教えて')
    await flush()
    mocks.playing = true
    mocks.readingTurn = 42
    player().events.emit('segmentstart', {
      segment: { turnId: 42, index: 0, text: '明日は晴れです。', audio: 'eA==', phonemes: null },
      durationMs: 3000
    })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '明日は晴れです。' })

    // The voice controller reports the barge-in, then the player stops and reports the turn it stopped.
    voice().events.emit('bargein', undefined)
    mocks.playing = false
    mocks.readingTurn = -1
    player().events.emit('idle', { turnId: 42 })
    await flush()

    const payloads = metricsLog.mock.calls.map((call) => call[0])
    expect(payloads.at(-1)).toMatchObject({ bargeIns: 1 })
  })
})

describe('a barge-in while a confirmation holds the conversation', () => {
  const request = { id: 'c1', title: 't', message: 'm', detail: 'd', confirmLabel: 'ok', destructive: false, holdsConversation: true }

  it('lets the waiting turn be heard again once the user answers, when no words followed the barge-in', async () => {
    let confirmEvent!: (event: unknown) => void
    await start({
      turnStart: vi.fn(async () => 42),
      onConfirmEvent: (listener: (event: unknown) => void) => {
        confirmEvent = listener
        return () => {}
      }
    })
    speak('調べておいて')
    await flush()
    confirmEvent({ type: 'open', request })
    voice().events.emit('bargein', undefined)
    player().beginTurn.mockClear()
    confirmEvent({ type: 'close', id: 'c1' })
    expect(player().beginTurn).toHaveBeenCalledWith(42, true)
  })

  it('leaves the player to the words that followed the barge-in', async () => {
    let confirmEvent!: (event: unknown) => void
    let answer!: (turnId: number) => void
    const turnStart = vi.fn().mockResolvedValueOnce(42).mockImplementationOnce(() => new Promise<number>((resolve) => (answer = resolve)))
    await start({
      turnStart,
      onConfirmEvent: (listener: (event: unknown) => void) => {
        confirmEvent = listener
        return () => {}
      }
    })
    speak('調べておいて')
    await flush()
    confirmEvent({ type: 'open', request })
    voice().events.emit('bargein', undefined)
    speak('はい')
    await flush()
    player().beginTurn.mockClear()
    confirmEvent({ type: 'close', id: 'c1' })
    expect(player().beginTurn).not.toHaveBeenCalled()
    answer(43)
  })
})

describe('the phase shown after a turn', () => {
  it('leaves think once the opening clip of a turn that already ended finishes', async () => {
    const conversation = await start({ turnStart: vi.fn(async () => 42) })
    speak('明日の予定を登録して')
    await flush()
    expect(mocks.turn.phase).toBe('think')

    // The turn fails at once, for instance without an API key, while "はい。" still sounds.
    conversation.handleTurnEvent({ type: 'error', turnId: 42, message: 'no key' })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '' })
    mocks.playing = false
    player().events.emit('idle', { turnId: 42 })

    expect(mocks.turn.phase).toBe('idle')
  })

  it('stays on think while the turn is still under way after its opening clip ends', async () => {
    await start({ turnStart: vi.fn(async () => 42) })
    speak('明日の予定を登録して')
    await flush()
    mocks.playing = false
    player().events.emit('idle', { turnId: 42 })

    expect(mocks.turn.phase).toBe('think')
  })
})

describe('a capture that yields no turn', () => {
  it('clears the partial transcript and goes back to the reply being read when the speech was its echo', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    // The assistant reads a reply and its voice leaks into the microphone.
    mocks.playing = true
    mocks.readingTurn = 7
    player().events.emit('segmentstart', {
      segment: { turnId: 7, index: 0, text: '明日の東京は晴れで、最高気温は28度です。', audio: 'eA==', phonemes: null },
      durationMs: 4000
    })
    const startedAt = performance.now()
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '明日の東京は晴れで')
    expect(mocks.turn.phase).toBe('listen')
    const end = speechEnd(startedAt, '明日の東京は晴れで')
    voice().events.emit('state', 'transcribing')
    utterance(end, '明日の東京は晴れで最高気温は28度です')
    voice().events.emit('state', 'listening')
    await flush()

    expect(turnStart).not.toHaveBeenCalled()
    expect(mocks.turn.partial).toBe('')
    expect(mocks.turn.phase).toBe('speak')
  })

  it('clears the partial transcript and leaves the listening phase when the microphone goes off mid-capture', async () => {
    await start({})
    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '明日の予定を')
    expect(mocks.turn.phase).toBe('listen')
    // disable() reports the capture dropped, then the state.
    voice().events.emit('speechdropped', { startedAt: 1 })
    voice().events.emit('state', 'off')

    expect(mocks.turn.partial).toBe('')
    expect(mocks.turn.phase).toBe('idle')
  })

  it('goes from listening to thinking with nothing between when the speech starts a turn while the previous one runs', async () => {
    const turnStart = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    await start({ turnStart })
    speak('明日の予定を登録して')
    await flush()

    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', 'やっぱり明後日')
    const end = speechEnd(performance.now() - 2000, 'やっぱり明後日')
    voice().events.emit('state', 'transcribing')
    mocks.turn.phases = []
    utterance(end, 'やっぱり明後日にして')
    voice().events.emit('state', 'listening')
    await flush()

    expect(turnStart).toHaveBeenLastCalledWith('やっぱり明後日にして', expect.anything())
    expect(mocks.turn.phases).not.toContain('idle')
    expect(mocks.turn.phase).toBe('think')
  })
})

describe('the measurements shown in the HUD', () => {
  const body = { turnId: 42, index: 0, text: '十時です。', audio: 'eA==', phonemes: null }
  const logged = (metricsLog: Mock): unknown =>
    metricsLog.mock.calls.map((call) => (call as Array<{ e2eMs?: number }>)[0]).find((payload) => payload.e2eMs !== undefined)?.e2eMs

  it('is the latest turn\'s, whose only sentence started sounding after brain reported it done', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    speak('今何時?')
    await flush()
    conversation.handleTurnEvent({ type: 'segment', turnId: 42, segment: body })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: body.text })
    // The opening clip ends and the reply's only sentence starts sounding.
    player().events.emit('segmentstart', { segment: body, durationMs: 900 })

    expect(logged(metricsLog)).toEqual(expect.any(Number))
    expect(mocks.turn.timings.e2eMs).toBe(logged(metricsLog))
  })

  it('leaves out what brain measured of a turn the next utterance has already reset the HUD for', async () => {
    const conversation = await start({ turnStart: vi.fn(async () => 42) })
    speak('今何時?')
    await flush()
    // The user speaks again while turn 42 is still thinking.
    speechEnd(performance.now() - 1500)
    conversation.handleTurnEvent({ type: 'metrics', turnId: 42, timings: { ttftMs: 777 } })

    expect(mocks.turn.timings.ttftMs).toBeUndefined()
  })

  it('counts the opening clip of the next utterance in the HUD, not in the measurements of the turn still under way', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    speak('今何時?')
    await flush()
    speechEnd(performance.now() - 1500)
    sound(lastClip(), 400)
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '' })

    expect(mocks.turn.timings.aizuchiMs).toEqual(expect.any(Number))
    const saved = savedRows(metricsLog)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.every((payload) => payload.aizuchiMs === undefined)).toBe(true)
  })

  it('measures a turn from its own utterance when the echo of its opening aizuchi ended in speech before it became a turn', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    const first = speechEnd(performance.now() - 2500)
    sound(lastClip(), 400)
    // The echo of that aizuchi makes a capture of its own, which ends while the first is still transcribed.
    const echo = speechEnd(performance.now() - 300)
    sound(lastClip(), 900)
    utterance(first, '今何時?')
    await flush()
    utterance(echo, 'はい')
    await flush()
    conversation.handleTurnEvent({ type: 'metrics', turnId: 42, timings: { ttftMs: 800, ttsMs: 120 } })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '十時です。' })

    expect(savedRows(metricsLog).at(-1)).toMatchObject({ vadMs: 350, asrMs: 400, aizuchiClipMs: 400, ttftMs: 800, ttsMs: 120 })
    // The echo came to nothing, so the HUD shows the turn again.
    expect(mocks.turn.timings).toMatchObject({ aizuchiClipMs: 400, ttftMs: 800 })
  })

  it('measures a typed turn from its own request when a speech ends while its id is on the way', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    let answer!: (turnId: number) => void
    const conversation = await start({ turnStart: vi.fn(() => new Promise<number>((resolve) => (answer = resolve))), metricsLog })
    const sending = conversation.sendTypedMessage('明日の天気は?')
    speechEnd(performance.now() - 1500)
    answer(42)
    await sending
    conversation.handleTurnEvent({ type: 'metrics', turnId: 42, timings: { ttftMs: 700 } })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '晴れです。' })

    const row = savedRows(metricsLog).at(-1)
    expect(row).toMatchObject({ typed: true, ttftMs: 700 })
    expect(row).not.toHaveProperty('vadMs')
  })

  it('stays out of the measurements of the next utterance when the older turn\'s sentence starts after it', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    speak('今何時?')
    await flush()
    conversation.handleTurnEvent({ type: 'segment', turnId: 42, segment: body })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: body.text })
    // The user speaks again before the reply sounds, and the HUD starts over for that utterance.
    speechEnd(performance.now() - 1500)
    player().events.emit('segmentstart', { segment: body, durationMs: 900 })

    expect(logged(metricsLog)).toEqual(expect.any(Number))
    expect(mocks.turn.timings.e2eMs).toBeUndefined()
  })
})

describe('the tray item that toggles the microphone', () => {
  it('turns the microphone off when it is on, and on again when it is off', async () => {
    let toggle!: () => void
    await start({
      onToggleMic: (callback: () => void) => {
        toggle = callback
        return () => {}
      }
    })
    voice().current = 'listening'
    toggle()
    await flush()
    expect(voice().disable).toHaveBeenCalledOnce()
    expect(voice().enable).not.toHaveBeenCalled()

    voice().current = 'off'
    toggle()
    await flush()
    expect(voice().enable).toHaveBeenCalledOnce()
  })
})

describe('the state of the speech services', () => {
  async function startPushed(): Promise<{ push: (status: AppStatus) => void; handled: Mock }> {
    let push!: (status: AppStatus) => void
    await start({
      getStatus: async () => ({ sequence: 1, asr: false, tts: true }),
      onStatusChanged: (callback: (status: AppStatus) => void) => {
        push = callback
        return () => {}
      }
    })
    const handled = (mocks.voice as { handleAsrStatus: Mock }).handleAsrStatus
    handled.mockClear()
    return { push, handled }
  }

  it('tells the conversation and the user that speech recognition came back when main pushes it', async () => {
    const { push, handled } = await startPushed()
    push({ sequence: 2, asr: true, tts: true } as AppStatus)
    expect(handled.mock.calls).toEqual([[true]])
    expect(mocks.toasts).toMatchObject([{ body: 'voice.services.recognitionBack' }])
  })

  it('tells them as well when a read of the settings overtook the push and the store keeps the read', async () => {
    const { push, handled } = await startPushed()
    // Main read status 2 for the push that says the server is back and status 3 for the settings just
    // after, and the answer to the settings arrives first.
    mocks.status!.getState().apply({ sequence: 3, asr: true, tts: true } as AppStatus)
    push({ sequence: 2, asr: true, tts: true } as AppStatus)
    expect(handled.mock.calls).toEqual([[true]])
    expect(mocks.toasts).toMatchObject([{ body: 'voice.services.recognitionBack' }])
  })
})

describe('the global shortcut that turns the microphone on', () => {
  async function pressShortcut(): Promise<void> {
    let hotkey!: () => void
    await start({
      onHotkeyMic: (callback: () => void) => {
        hotkey = callback
        return () => {}
      }
    })
    voice().current = 'off'
    hotkey()
    await flush()
    voice().current = 'listening'
  }

  it('leaves the microphone off during the first-run setup', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 0, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('leaves the microphone off while the notice of the risks is unanswered', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 1, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('turns the microphone on once both are answered', async () => {
    await pressShortcut()
    expect(voice().enable).toHaveBeenCalledOnce()
  })
})

describe('a change of how long a quiet live session stays open', () => {
  it('turns the microphone off, since main stops the live engine for it', async () => {
    Object.assign(mocks.settings, { voiceEngine: 'gemini-live' })
    await start({})
    const live = mocks.live as { current: string; disable: Mock }
    live.current = 'on'
    const before = structuredClone(mocks.settings)
    const after = { ...before, liveIdleSeconds: 120 }

    mocks.settingsListener!({ settings: after }, { settings: before })

    expect(live.disable).toHaveBeenCalled()
    live.current = 'off'
  })
})

describe('the voice of the live engine', () => {
  it('plays none of what main sent before it handled the microphone being turned off, even when the microphone turns on again at once', async () => {
    Object.assign(mocks.settings, { voiceEngine: 'gemini-live' })
    const { LiveVoice } = await vi.importActual<typeof import('@/voice/LiveVoice')>('@/voice/LiveVoice')
    const live = new LiveVoice()
    Object.assign(live, {
      microphone: { start: async () => {}, stop: () => {}, close: () => {} },
      silero: { init: async () => {}, push: () => {}, currentProb: () => null, dispose: () => {} }
    })
    mocks.realLive = live
    const listeners = new Set<(audio: LiveAudio) => void>()
    let runs = 0
    const conversation = await start({
      requestMicPermission: async () => true,
      liveStart: async () => ({ ok: true, run: ++runs }),
      onLiveAudio: (listener: (audio: LiveAudio) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
    const streamPush = vi.spyOn(mocks.player as { streamPush: (samples: Float32Array, rate: number) => void }, 'streamPush')
    /** A chunk of the voice of the engine main started as `run`, which reaches the page some time later. */
    const chunkFromMain = (run: number): void => {
      for (const listener of [...listeners]) listener({ run, samples: new Float32Array(2400) })
    }

    await conversation.toggleMic()
    chunkFromMain(1)
    expect(streamPush).toHaveBeenCalledOnce()

    await conversation.toggleMic()
    chunkFromMain(1)
    expect(streamPush).toHaveBeenCalledOnce()

    // Coming back after a sleep turns the microphone off and on again in one go, and the stopped run's
    // voice still on its way arrives while the new one starts.
    await conversation.toggleMic()
    const recovering = live.recover()
    chunkFromMain(2)
    await recovering
    expect(streamPush).toHaveBeenCalledOnce()
    chunkFromMain(3)
    expect(streamPush).toHaveBeenCalledTimes(2)
    live.disable()
  })
})

describe('a page that loads while main waits for the answer to a confirmation', () => {
  it('puts every request main is waiting on onto the sheet, asking for them only once it listens for new ones', async () => {
    const request = { id: 'c1', title: 't', message: 'm', detail: 'd', confirmLabel: 'ok', destructive: false, holdsConversation: true }
    const calls: string[] = []
    await start({
      onConfirmEvent: () => {
        calls.push('listen')
        return () => {}
      },
      confirmPending: async () => {
        calls.push('ask')
        return [request]
      }
    })
    expect(calls).toEqual(['listen', 'ask'])
    expect(mocks.confirmOpened).toEqual([request])
  })
})
