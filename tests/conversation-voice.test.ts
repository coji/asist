import { beforeEach, describe, expect, it, vi } from 'vitest'
import mitt from 'mitt'

/**
 * The conversation driven by the events of the voice pipeline: the voice controller and the speech
 * player are replaced by emitters, and the stores by plain objects.
 */

const mocks = vi.hoisted(() => {
  const turn = {
    phase: 'idle' as string,
    activeTurnId: -1,
    timings: {},
    setPhase: (phase: string) => {
      turn.phase = phase
    },
    setActiveTurn: (id: number) => {
      turn.activeTurnId = id
    },
    resetTimings: () => {},
    mergeTimings: () => {},
    setPartial: () => {},
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
    settingsListener: null as ((state: { settings: unknown }, before: { settings: unknown }) => void) | null,
    player: null as unknown,
    voice: null as unknown,
    live: null as unknown,
    /** The requests the conversation put on the confirmation sheet. */
    confirmOpened: [] as unknown[]
  }
})

const baseSettings = {
  aizuchi: true,
  aizuchiRate: 1,
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
  gptLive: { model: 'gpt-live', voice: 'alloy' },
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
    handleAsrStatus: () => {},
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
  return { liveVoice }
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
    playClip: vi.fn(() => {
      mocks.playing = true
    }),
    discardBody: vi.fn(),
    dropWaiting: vi.fn(),
    beginTurn: vi.fn(),
    enqueue: vi.fn(),
    interrupt: vi.fn(),
    bodyQueuedAfter: () => false,
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
  pickAizuchi: vi.fn(() => ({ text: 'はい。', category: 'flow', weight: 1, audio: 'eA==' })),
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
    useStatusStore: plain({ status: { asr: true, tts: true } }),
    useToastStore: plain(),
    useTaskStore: plain(),
    useNoteStore: plain(),
    useMailStore: plain()
  }
})

type Emitter = ReturnType<typeof mitt>
type Mock = ReturnType<typeof vi.fn>

const voice = (): { events: Emitter; enable: Mock; disable: Mock; current: string } =>
  mocks.voice as { events: Emitter; enable: Mock; disable: Mock; current: string }
const player = (): { events: Emitter; playClip: Mock; beginTurn: Mock } =>
  mocks.player as { events: Emitter; playClip: Mock; beginTurn: Mock }

function api(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => () => {}
      if (key === 'getStatus') return async () => ({ asr: true, tts: true })
      if (key === 'confirmPending') return async () => []
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

beforeEach(() => {
  vi.resetModules()
  mocks.playing = false
  mocks.readingTurn = -1
  mocks.turn.phase = 'idle'
  mocks.turn.activeTurnId = -1
  mocks.turn.timings = {}
  mocks.confirmOpened = []
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

  it('is counted against a reply that is still being read after brain reported it done', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    mocks.turn.timings = { vadMs: 350 }
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

describe('the global shortcut and the tray item that turn the microphone on', () => {
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

  it('leave the microphone off during the first-run setup', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 0, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('leave the microphone off while the notice of the risks is unanswered', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 1, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('turn the microphone on once both are answered', async () => {
    await pressShortcut()
    expect(voice().enable).toHaveBeenCalledOnce()
  })
})

describe('a change of how long a quiet live session stays open', () => {
  it('turns the microphone off, since main stops the live engine for it', async () => {
    Object.assign(mocks.settings, { voiceEngine: 'gpt-live' })
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

describe('the feed under GPT-Live', () => {
  it('shows what the user says and brain’s text for the turn the voice handed over, and closes both lines', async () => {
    Object.assign(mocks.settings, { voiceEngine: 'gpt-live' })
    let onLiveEvent!: (event: unknown) => void
    const conversation = await start({
      onLiveEvent: (listener: (event: unknown) => void) => {
        onLiveEvent = listener
        return () => {}
      }
    })
    onLiveEvent({ type: 'userTranscript', turnId: 100, text: '明日の', final: false })
    onLiveEvent({ type: 'userTranscript', turnId: 100, text: '明日の天気は', final: true })
    conversation.handleTurnEvent({ type: 'started', turnId: 42, origin: 'live' })
    conversation.handleTurnEvent({ type: 'delta', turnId: 42, text: '明日は晴れです。' })
    conversation.handleTurnEvent({ type: 'delta', turnId: 42, text: '傘はいりません。' })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '明日は晴れです。傘はいりません。' })

    expect(mocks.feed.lines.filter((line) => line.role !== 'sys').map(({ role, text, streaming }) => [role, text, streaming])).toEqual([
      ['user', '明日の天気は', false],
      ['ai', '明日は晴れです。傘はいりません。', false]
    ])
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
