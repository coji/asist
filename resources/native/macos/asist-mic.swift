import AVFoundation
import CoreAudio
import Foundation

// asist-mic: the helper that captures the microphone through macOS voice processing (AEC, NS, AGC).
//
// Chromium's getUserMedia cannot use Apple's VoiceProcessingIO, so the capture happens through
// AVAudioEngine and the raw stream, mono float32 at 48 kHz in little endian, goes to stdout. Apple's AEC
// uses the whole system's output as its reference signal, so the echo of the TTS that Chromium plays is
// cancelled here as well. Logs go to stderr.
//
// Exit codes:
//   0 = a normal exit, where EOF on stdin is the parent asking it to stop
//   2 = the default input or output device changed, or capture could not start again after the audio
//       configuration changed, and the parent restarts it
//   3 = voice processing cannot be enabled
//   4 = there is no input device, or the engine failed to start
//   5 = the audio configuration keeps changing, and the parent gives voice processing up
//
// Arguments: how many changes of the configuration within how many seconds mean that it keeps changing,
// the limit the parent also applies to changes of the device.
//
// scripts/resources/native-macos.mjs builds it with swiftc.

func log(_ message: String) {
  FileHandle.standardError.write(Data(("asist-mic: " + message + "\n").utf8))
}

// A closed stdout, which means the parent died, is noticed as a failed write rather than a crash.
signal(SIGPIPE, SIG_IGN)

// The parent asks it to stop with EOF on stdin, which does not depend on a race with a kill.
Thread.detachNewThread {
  while readLine(strippingNewline: false) != nil {}
  exit(0)
}

// A top-level guard would make every function after it a local function of the script, which the
// configuration change handler cannot call from its concurrent closure.
let (changeLimit, changeWindow): (Int, TimeInterval) = {
  let arguments = CommandLine.arguments
  guard arguments.count == 3, let limit = Int(arguments[1]), let window = TimeInterval(arguments[2]) else {
    log("expected the limit of configuration changes and its window in seconds")
    exit(4)
  }
  return (limit, window)
}()

let engine = AVAudioEngine()
let input = engine.inputNode

func enableVoiceProcessing() {
  do {
    try input.setVoiceProcessingEnabled(true)
  } catch {
    log("voice processing unavailable: \(error.localizedDescription)")
    exit(3)
  }
  // Ducking the TTS playback volume is SpeechPlayer's job in the app. Being ducked twice makes the volume
  // unstable, so voice processing's own ducking is turned off.
  if #available(macOS 14.0, *) {
    input.voiceProcessingOtherAudioDuckingConfiguration =
      AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
        enableAdvancedDucking: false,
        duckingLevel: .min
      )
  }
}

let outFormat: AVAudioFormat = {
  guard
    let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 1,
      interleaved: false
    )
  else {
    log("the 48 kHz output format is unavailable")
    exit(4)
  }
  return format
}()

func writeAll(_ data: Data) {
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    var offset = 0
    while offset < raw.count {
      let written = write(1, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      if written <= 0 {
        // The parent stopped reading.
        exit(0)
      }
      offset += written
    }
  }
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var device = AudioDeviceID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
  return device
}

/// Installs the tap for the input's current format and starts the engine, returning false when it cannot.
func startCapture() -> Bool {
  // The format is only settled once voice processing is enabled, and it changes with the configuration.
  let hwFormat = input.outputFormat(forBus: 0)
  guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
    log("no usable input device")
    return false
  }
  guard let converter = AVAudioConverter(from: hwFormat, to: outFormat) else {
    log("audio converter unavailable for \(hwFormat.sampleRate)Hz")
    return false
  }
  // A voice processing input node sometimes reports more channels than the hardware has, which is one;
  // 9 were measured. Averaging them down would thin the voice to 1/N and it would no longer reach the VAD,
  // so channel 0, the main microphone, is taken on its own.
  if hwFormat.channelCount > 1 {
    converter.channelMap = [0]
  }

  // The peak of each channel over the first two seconds is reported once per configuration, which is what
  // tells you which channel actually carries the voice and whether taking channel 0 is right.
  var diagnosticFramesLeft = Int(hwFormat.sampleRate) * 2
  var diagnosticPeaks = [Float](repeating: 0, count: Int(hwFormat.channelCount))
  var diagnosticReported = false

  input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
    if !diagnosticReported, let channels = buffer.floatChannelData {
      for channel in 0..<Int(buffer.format.channelCount) {
        var peak: Float = 0
        let samples = channels[channel]
        for index in 0..<Int(buffer.frameLength) {
          peak = max(peak, abs(samples[index]))
        }
        if channel < diagnosticPeaks.count {
          diagnosticPeaks[channel] = max(diagnosticPeaks[channel], peak)
        }
      }
      diagnosticFramesLeft -= Int(buffer.frameLength)
      if diagnosticFramesLeft <= 0 {
        diagnosticReported = true
        let formatted = diagnosticPeaks.map { String(format: "%.4f", $0) }.joined(separator: ",")
        log("channel peaks (first 2s): [\(formatted)]")
      }
    }
    let ratio = outFormat.sampleRate / hwFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var consumed = false
    var conversionError: NSError?
    converter.convert(to: out, error: &conversionError) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if conversionError != nil { return }
    guard out.frameLength > 0, let channel = out.floatChannelData?[0] else { return }
    writeAll(Data(bytes: channel, count: Int(out.frameLength) * MemoryLayout<Float>.size))
  }

  engine.prepare()
  do {
    try engine.start()
  } catch {
    log("engine start failed: \(error.localizedDescription)")
    input.removeTap(onBus: 0)
    return false
  }
  log("ready input=\(hwFormat.sampleRate)Hz ch=\(hwFormat.channelCount) → 48000Hz mono")
  return true
}

enableVoiceProcessing()
let inputDevice = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
let outputDevice = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)

// A Bluetooth headset switches to its hands-free profile once its microphone opens, which changes the
// sample rate and the channels and posts a configuration change; 16 kHz with 3 channels was logged on
// 2026-09-26. Exiting on it would release the microphone, the headset would switch back, and every new
// helper would meet the same change. The same devices are therefore kept open and capture starts again on
// the new format. Only another default device gets a new process, which opens it from scratch. A headset
// that keeps switching would otherwise restart capture forever, with a gap each time, so changes past the
// limit end the helper and the parent moves to getUserMedia.
var configurationChanges: [Date] = []

func followConfigurationChange() {
  if defaultDevice(kAudioHardwarePropertyDefaultInputDevice) != inputDevice
    || defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) != outputDevice
  {
    log("audio device changed")
    exit(2)
  }
  let now = Date()
  configurationChanges = configurationChanges.filter { now.timeIntervalSince($0) < changeWindow } + [now]
  if configurationChanges.count > changeLimit {
    log("audio configuration keeps changing")
    exit(5)
  }
  log("audio configuration changed; capturing again")
  engine.stop()
  input.removeTap(onBus: 0)
  if !input.isVoiceProcessingEnabled {
    enableVoiceProcessing()
  }
  if !startCapture() {
    exit(2)
  }
}

// The notification arrives on an internal thread, possibly while the main thread is still starting the
// engine, so the restart is queued on the main thread behind that start.
NotificationCenter.default.addObserver(
  forName: .AVAudioEngineConfigurationChange,
  object: engine,
  queue: nil
) { _ in
  DispatchQueue.main.async {
    followConfigurationChange()
  }
}

if !startCapture() {
  exit(4)
}
RunLoop.main.run()
