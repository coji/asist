#define COBJMACROS
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Captures the default microphone through the communications processing of Windows, whose echo canceller
 * takes what the default speakers play as its reference, and so removes the echo of every program's sound,
 * not only of what Chromium plays. It is the Windows side of the macOS asist-mic and speaks the same
 * protocol to ASIST.
 *
 *   asist-mic --version
 *   asist-mic --check
 *   asist-mic <change-limit> <window-seconds>
 *
 * Capture writes mono float32 at 48 kHz, little endian, to stdout and logs to stderr. EOF on stdin asks it
 * to stop. The arguments say how many changes of the audio configuration within how many seconds mean that
 * it keeps changing.
 *
 * --check opens the default microphone the same way without starting it, writes on stdout whether echo
 * cancellation is on, the effects Windows lists for the stream and the device names, and exits with the
 * code capture would have met.
 *
 * Exit codes:
 *   0 = a normal exit, where EOF on stdin or a closed stdout is the parent asking it to stop
 *   2 = the default microphone or speakers changed, or capture could not start again after the audio
 *       configuration changed, and the parent restarts it
 *   3 = echo cancellation is not on for the stream
 *   4 = there is no microphone, or opening or starting it failed
 *   5 = the audio configuration keeps changing, and the parent gives capture up
 */

#define MIC_VERSION "1"

#define EXIT_OK 0
#define EXIT_DEVICE_CHANGED 2
#define EXIT_NO_ECHO_CANCELLATION 3
#define EXIT_NO_DEVICE 4
#define EXIT_KEEPS_CHANGING 5

#define SAMPLE_RATE 48000
#define MAX_CHANGE_LIMIT 32
/** 100 ms in the 100 ns units of REFERENCE_TIME; in event mode the engine still signals every period. */
#define BUFFER_DURATION 1000000
/**
 * How long capture waits for the engine's event before it reads the stream anyway. An invalidated stream,
 * after a format change or a Bluetooth profile switch, may never signal again, and only a read reports
 * AUDCLNT_E_DEVICE_INVALIDATED.
 */
#define READ_TIMEOUT_MS 2000

/**
 * The GUIDs of the interfaces and the class this program uses. The values are those of the Windows SDK
 * headers (mmdeviceapi.h, audioclient.h), declared here because a C program finds no definition of the
 * SDK's IID_ constants to link against.
 */
static const CLSID ENUMERATOR_CLASS = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
static const IID ENUMERATOR_INTERFACE = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
static const IID NOTIFICATION_INTERFACE = {0x7991EEC9, 0x7E89, 0x4D85, {0x83, 0x90, 0x6C, 0x70, 0x3C, 0xEC, 0x60, 0xC0}};
static const IID UNKNOWN_INTERFACE = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const IID AUDIO_CLIENT2_INTERFACE = {0x726778CD, 0xF60A, 0x4EDA, {0x82, 0xDE, 0xE4, 0x76, 0x10, 0xCD, 0x78, 0xAA}};
static const IID CAPTURE_CLIENT_INTERFACE = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const IID SESSION_CONTROL_INTERFACE = {0xF4B1A599, 0x7266, 0x4319, {0xA8, 0xCA, 0xE7, 0x0A, 0xCB, 0x11, 0xE8, 0xCD}};
static const IID SESSION_CONTROL2_INTERFACE = {0xBFB7FF88, 0x7239, 0x4FC9, {0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}};

/** PKEY_Device_FriendlyName of functiondiscoverykeys_devpkey.h, whose definition no library carries either. */
static const PROPERTYKEY FRIENDLY_NAME = {{0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 14};

/**
 * IAudioEffectsManager (Windows 11, build 22000) and IAcousticEchoCancellationControl (build 22621) are
 * missing from the Windows SDK 10.0.19041 that the Visual Studio 2017 of the Windows test machine carries,
 * so their GUIDs, AUDIO_EFFECT and the methods in their vtable order are copied from audioclient.h of SDK
 * 10.0.22621, and the effect types from ksmedia.h of the same SDK. The names differ from the SDK's so that
 * a newer SDK, which declares the originals, compiles this file as well.
 */
static const IID EFFECTS_MANAGER_INTERFACE = {0x4460B3AE, 0x4B44, 0x4527, {0x86, 0x76, 0x75, 0x48, 0xA8, 0xAC, 0xD2, 0x60}};
static const IID ECHO_CONTROL_INTERFACE = {0xF4AE25B5, 0xAAA3, 0x437D, {0xB6, 0xB3, 0xDB, 0xBE, 0x2D, 0x0E, 0x95, 0x49}};

/** AUDIO_EFFECT_STATE_ON. */
#define EFFECT_STATE_ON 1

typedef struct Effect {
    GUID id;
    BOOL canSetState;
    int state;
} Effect;

typedef struct EffectsManager EffectsManager;
typedef struct EffectsManagerVtbl {
    HRESULT(STDMETHODCALLTYPE *QueryInterface)(EffectsManager *self, REFIID riid, void **object);
    ULONG(STDMETHODCALLTYPE *AddRef)(EffectsManager *self);
    ULONG(STDMETHODCALLTYPE *Release)(EffectsManager *self);
    HRESULT(STDMETHODCALLTYPE *RegisterAudioEffectsChangedNotificationCallback)(EffectsManager *self, IUnknown *client);
    HRESULT(STDMETHODCALLTYPE *UnregisterAudioEffectsChangedNotificationCallback)(EffectsManager *self, IUnknown *client);
    HRESULT(STDMETHODCALLTYPE *GetAudioEffects)(EffectsManager *self, Effect **effects, UINT32 *count);
    HRESULT(STDMETHODCALLTYPE *SetAudioEffectState)(EffectsManager *self, GUID effect, int state);
} EffectsManagerVtbl;
struct EffectsManager {
    const EffectsManagerVtbl *lpVtbl;
};

typedef struct EchoControl EchoControl;
typedef struct EchoControlVtbl {
    HRESULT(STDMETHODCALLTYPE *QueryInterface)(EchoControl *self, REFIID riid, void **object);
    ULONG(STDMETHODCALLTYPE *AddRef)(EchoControl *self);
    ULONG(STDMETHODCALLTYPE *Release)(EchoControl *self);
    HRESULT(STDMETHODCALLTYPE *SetEchoCancellationRenderEndpoint)(EchoControl *self, LPCWSTR endpoint);
} EchoControlVtbl;
struct EchoControl {
    const EchoControlVtbl *lpVtbl;
};

#define ECHO_CANCELLATION_EFFECT {0x6F64ADBE, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}

static const GUID ECHO_CANCELLATION = ECHO_CANCELLATION_EFFECT;

/** The effect types a log names, in ksmedia.h's AUDIO_EFFECT_TYPE_ order; any other is written as its GUID. */
static const struct {
    GUID id;
    const char *name;
} EFFECT_NAMES[] = {
    {ECHO_CANCELLATION_EFFECT, "acoustic-echo-cancellation"},
    {{0x6F64ADBF, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "noise-suppression"},
    {{0x6F64ADC0, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "automatic-gain-control"},
    {{0x6F64ADC1, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "beamforming"},
    {{0x6F64ADC2, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "constant-tone-removal"},
    {{0x6F64ADCF, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "far-field-beamforming"},
    {{0x6F64ADD0, 0x8211, 0x11E2, {0x8C, 0x70, 0x2C, 0x27, 0xD7, 0xF0, 0x01, 0xFA}}, "deep-noise-suppression"},
};

/** An open stream on the default microphone, with the endpoints it was opened for. */
typedef struct Capture {
    IAudioClient2 *client;
    IAudioCaptureClient *reader;
    /** CoTaskMem strings; render_id is NULL when there are no speakers. */
    wchar_t *capture_id;
    wchar_t *render_id;
    char microphone[256];
    char reference[256];
    char effects[1024];
    int echo_cancelled;
} Capture;

static HANDLE default_changed;

static void say(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    fputs("asist-mic: ", stderr);
    vfprintf(stderr, format, args);
    fputc('\n', stderr);
    va_end(args);
}

static void to_utf8(const wchar_t *text, char *out, size_t capacity)
{
    if (WideCharToMultiByte(CP_UTF8, 0, text, -1, out, (int)capacity, NULL, NULL) == 0) out[0] = '\0';
}

/** The name Sound settings shows for a device, or its endpoint ID when the name cannot be read. */
static void device_name(IMMDevice *device, const wchar_t *id, char *out, size_t capacity)
{
    IPropertyStore *store = NULL;
    PROPVARIANT value;
    PropVariantInit(&value);
    to_utf8(id, out, capacity);
    if (FAILED(IMMDevice_OpenPropertyStore(device, STGM_READ, &store))) return;
    if (SUCCEEDED(IPropertyStore_GetValue(store, &FRIENDLY_NAME, &value)) && value.vt == VT_LPWSTR) {
        to_utf8(value.pwszVal, out, capacity);
    }
    PropVariantClear(&value);
    IPropertyStore_Release(store);
}

/** The endpoint ID of the default console device of a direction, or NULL with the HRESULT when there is none. */
static HRESULT default_id(IMMDeviceEnumerator *enumerator, EDataFlow flow, IMMDevice **device, wchar_t **id)
{
    IMMDevice *found = NULL;
    *id = NULL;
    HRESULT hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, flow, eConsole, &found);
    if (FAILED(hr)) return hr;
    hr = IMMDevice_GetId(found, id);
    if (FAILED(hr) || device == NULL) {
        IMMDevice_Release(found);
    } else {
        *device = found;
    }
    return hr;
}

static int same_id(const wchar_t *a, const wchar_t *b)
{
    if (a == NULL || b == NULL) return a == b;
    return wcscmp(a, b) == 0;
}

/** Whether the default microphone or speakers are no longer the ones the capture was opened for. */
static int defaults_changed(IMMDeviceEnumerator *enumerator, const Capture *capture)
{
    wchar_t *capture_id;
    wchar_t *render_id;
    default_id(enumerator, eCapture, NULL, &capture_id);
    default_id(enumerator, eRender, NULL, &render_id);
    int changed = !same_id(capture_id, capture->capture_id) || !same_id(render_id, capture->render_id);
    CoTaskMemFree(capture_id);
    CoTaskMemFree(render_id);
    return changed;
}

/**
 * Lists the effects Windows applies to the stream into capture->effects and sets echo_cancelled when
 * acoustic echo cancellation is among them and on. Listing an effect is not enough: Voice Clarity and
 * drivers list it as off when the user or the device turned it off.
 */
static void read_effects(Capture *capture)
{
    EffectsManager *manager = NULL;
    Effect *effects = NULL;
    UINT32 count = 0;
    capture->echo_cancelled = 0;
    HRESULT hr = IAudioClient2_GetService(capture->client, &EFFECTS_MANAGER_INTERFACE, (void **)&manager);
    if (FAILED(hr)) {
        snprintf(capture->effects, sizeof capture->effects, "unavailable (0x%08lx)", (unsigned long)hr);
        return;
    }
    hr = manager->lpVtbl->GetAudioEffects(manager, &effects, &count);
    manager->lpVtbl->Release(manager);
    if (FAILED(hr)) {
        snprintf(capture->effects, sizeof capture->effects, "unreadable (0x%08lx)", (unsigned long)hr);
        return;
    }
    size_t used = 0;
    capture->effects[0] = '\0';
    for (UINT32 i = 0; i < count; i++) {
        char unnamed[64];
        const char *name = NULL;
        for (size_t known = 0; known < sizeof EFFECT_NAMES / sizeof EFFECT_NAMES[0]; known++) {
            if (IsEqualGUID(&effects[i].id, &EFFECT_NAMES[known].id)) name = EFFECT_NAMES[known].name;
        }
        if (name == NULL) {
            wchar_t text[40];
            StringFromGUID2(&effects[i].id, text, 40);
            to_utf8(text, unnamed, sizeof unnamed);
            name = unnamed;
        }
        const int on = effects[i].state == EFFECT_STATE_ON;
        if (IsEqualGUID(&effects[i].id, &ECHO_CANCELLATION) && on) capture->echo_cancelled = 1;
        int written = snprintf(capture->effects + used, sizeof capture->effects - used, "%s%s=%s", used ? " " : "", name, on ? "on" : "off");
        if (written < 0 || (size_t)written >= sizeof capture->effects - used) break;
        used += (size_t)written;
    }
    if (count == 0) snprintf(capture->effects, sizeof capture->effects, "none");
    CoTaskMemFree(effects);
}

/**
 * Points the echo canceller at the default speakers, which is where ASIST's own voice plays. Without the
 * control, which Windows has from build 22621, the canceller keeps the reference Windows chose.
 */
static void set_reference(IMMDeviceEnumerator *enumerator, Capture *capture)
{
    IMMDevice *speakers = NULL;
    EchoControl *control = NULL;
    HRESULT hr = default_id(enumerator, eRender, &speakers, &capture->render_id);
    if (FAILED(hr)) {
        snprintf(capture->reference, sizeof capture->reference, "none (no speakers, 0x%08lx)", (unsigned long)hr);
        return;
    }
    char name[200];
    device_name(speakers, capture->render_id, name, sizeof name);
    IMMDevice_Release(speakers);
    hr = IAudioClient2_GetService(capture->client, &ECHO_CONTROL_INTERFACE, (void **)&control);
    if (FAILED(hr)) {
        snprintf(capture->reference, sizeof capture->reference, "chosen by Windows (no control, 0x%08lx)", (unsigned long)hr);
        return;
    }
    hr = control->lpVtbl->SetEchoCancellationRenderEndpoint(control, capture->render_id);
    control->lpVtbl->Release(control);
    if (FAILED(hr)) {
        snprintf(capture->reference, sizeof capture->reference, "chosen by Windows (setting %s failed, 0x%08lx)", name, (unsigned long)hr);
        return;
    }
    snprintf(capture->reference, sizeof capture->reference, "%s", name);
}

static void close_capture(Capture *capture)
{
    if (capture->reader) IAudioCaptureClient_Release(capture->reader);
    if (capture->client) IAudioClient2_Release(capture->client);
    CoTaskMemFree(capture->capture_id);
    CoTaskMemFree(capture->render_id);
    memset(capture, 0, sizeof *capture);
}

/**
 * Opens a communications stream on the default console microphone, in 48 kHz mono float32, and returns
 * EXIT_OK, EXIT_NO_ECHO_CANCELLATION or EXIT_NO_DEVICE. The stream is not started.
 */
static int open_capture(IMMDeviceEnumerator *enumerator, Capture *capture)
{
    IMMDevice *microphone = NULL;
    memset(capture, 0, sizeof *capture);
    HRESULT hr = default_id(enumerator, eCapture, &microphone, &capture->capture_id);
    if (FAILED(hr)) {
        say("no default microphone (0x%08lx)", (unsigned long)hr);
        return EXIT_NO_DEVICE;
    }
    device_name(microphone, capture->capture_id, capture->microphone, sizeof capture->microphone);
    hr = IMMDevice_Activate(microphone, &AUDIO_CLIENT2_INTERFACE, CLSCTX_ALL, NULL, (void **)&capture->client);
    IMMDevice_Release(microphone);
    if (FAILED(hr)) {
        say("cannot activate %s (0x%08lx)", capture->microphone, (unsigned long)hr);
        close_capture(capture);
        return EXIT_NO_DEVICE;
    }

    // The communications category is what makes Windows run the echo canceller of the driver or Voice
    // Clarity on the stream; the default and RAW categories leave it out.
    AudioClientProperties properties;
    memset(&properties, 0, sizeof properties);
    properties.cbSize = sizeof properties;
    properties.bIsOffload = FALSE;
    properties.eCategory = AudioCategory_Communications;
    hr = IAudioClient2_SetClientProperties(capture->client, &properties);
    if (FAILED(hr)) {
        say("cannot set the communications category on %s (0x%08lx)", capture->microphone, (unsigned long)hr);
        close_capture(capture);
        return EXIT_NO_DEVICE;
    }

    WAVEFORMATEX format;
    memset(&format, 0, sizeof format);
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 1;
    format.nSamplesPerSec = SAMPLE_RATE;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = SAMPLE_RATE * 4;
    // AUTOCONVERTPCM has the engine convert the device's own rate and channels to this format, so the output
    // stays 48 kHz mono whatever the microphone is.
    hr = IAudioClient2_Initialize(capture->client, AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                  BUFFER_DURATION, 0, &format, NULL);
    if (FAILED(hr)) {
        say("cannot open %s (0x%08lx)", capture->microphone, (unsigned long)hr);
        close_capture(capture);
        return EXIT_NO_DEVICE;
    }

    read_effects(capture);
    set_reference(enumerator, capture);
    if (!capture->echo_cancelled) {
        say("echo cancellation is not on for %s; effects: %s", capture->microphone, capture->effects);
        return EXIT_NO_ECHO_CANCELLATION;
    }
    hr = IAudioClient2_GetService(capture->client, &CAPTURE_CLIENT_INTERFACE, (void **)&capture->reader);
    if (FAILED(hr)) {
        say("cannot read from %s (0x%08lx)", capture->microphone, (unsigned long)hr);
        close_capture(capture);
        return EXIT_NO_DEVICE;
    }
    return EXIT_OK;
}

static int check(IMMDeviceEnumerator *enumerator)
{
    Capture capture;
    const int status = open_capture(enumerator, &capture);
    if (status == EXIT_NO_DEVICE) return status;
    printf("echo-cancellation: %s\n", capture.echo_cancelled ? "on" : "off");
    printf("effects: %s\n", capture.effects);
    printf("microphone: %s\n", capture.microphone);
    printf("echo-reference: %s\n", capture.reference);
    close_capture(&capture);
    return status;
}

/** Writes all of data to stdout, and ends the process once the parent has stopped reading. */
static void write_all(HANDLE out, const void *data, DWORD size)
{
    const char *next = data;
    while (size > 0) {
        DWORD written = 0;
        if (!WriteFile(out, next, size, &written, NULL)) {
            DWORD error = GetLastError();
            if (error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA) say("writing the audio failed with error %lu", error);
            exit(EXIT_OK);
        }
        next += written;
        size -= written;
    }
}

/** Writes every packet the stream holds; a silent packet carries no data and is written as zeros. */
static HRESULT drain(Capture *capture, HANDLE out)
{
    static const float silence[1024] = {0};
    for (;;) {
        UINT32 frames = 0;
        HRESULT hr = IAudioCaptureClient_GetNextPacketSize(capture->reader, &frames);
        if (FAILED(hr) || frames == 0) return hr;
        BYTE *data = NULL;
        DWORD flags = 0;
        hr = IAudioCaptureClient_GetBuffer(capture->reader, &data, &frames, &flags, NULL, NULL);
        if (FAILED(hr) || hr == AUDCLNT_S_BUFFER_EMPTY) return FAILED(hr) ? hr : S_OK;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            for (UINT32 left = frames; left > 0;) {
                UINT32 chunk = left < 1024 ? left : 1024;
                write_all(out, silence, (DWORD)(chunk * sizeof(float)));
                left -= chunk;
            }
        } else {
            write_all(out, data, (DWORD)(frames * sizeof(float)));
        }
        hr = IAudioCaptureClient_ReleaseBuffer(capture->reader, frames);
        if (FAILED(hr)) return hr;
    }
}

/**
 * Opts the stream's session out of the ducking Windows applies while a communications stream runs, which
 * by default lowers every other sound, the spoken reply included, by 80%. The macOS helper turns the same
 * ducking off. A failure leaves capture working with the other sounds lowered, so it is only logged.
 */
static void keep_other_sounds(Capture *capture)
{
    IAudioSessionControl *session = NULL;
    IAudioSessionControl2 *session2 = NULL;
    HRESULT hr = IAudioClient2_GetService(capture->client, &SESSION_CONTROL_INTERFACE, (void **)&session);
    if (SUCCEEDED(hr)) {
        hr = IAudioSessionControl_QueryInterface(session, &SESSION_CONTROL2_INTERFACE, (void **)&session2);
        IAudioSessionControl_Release(session);
    }
    if (SUCCEEDED(hr)) {
        hr = IAudioSessionControl2_SetDuckingPreference(session2, TRUE);
        IAudioSessionControl2_Release(session2);
    }
    if (FAILED(hr)) say("other sounds are lowered while %s is on (0x%08lx)", capture->microphone, (unsigned long)hr);
}

static int start_capture(Capture *capture, HANDLE ready)
{
    keep_other_sounds(capture);
    HRESULT hr = IAudioClient2_SetEventHandle(capture->client, ready);
    if (SUCCEEDED(hr)) hr = IAudioClient2_Start(capture->client);
    if (FAILED(hr)) {
        say("cannot start %s (0x%08lx)", capture->microphone, (unsigned long)hr);
        return 0;
    }
    say("ready: %s, 48000 Hz mono; effects: %s; echo reference: %s", capture->microphone, capture->effects, capture->reference);
    return 1;
}

static HRESULT STDMETHODCALLTYPE notification_query(IMMNotificationClient *self, REFIID riid, void **object)
{
    if (IsEqualIID(riid, &UNKNOWN_INTERFACE) || IsEqualIID(riid, &NOTIFICATION_INTERFACE)) {
        *object = self;
        return S_OK;
    }
    *object = NULL;
    return E_NOINTERFACE;
}

/** The client is a static object that is never freed, so it keeps no count of its references. */
static ULONG STDMETHODCALLTYPE notification_add_ref(IMMNotificationClient *self)
{
    UNREFERENCED_PARAMETER(self);
    return 1;
}

static ULONG STDMETHODCALLTYPE notification_release(IMMNotificationClient *self)
{
    UNREFERENCED_PARAMETER(self);
    return 1;
}

static HRESULT STDMETHODCALLTYPE notification_state(IMMNotificationClient *self, LPCWSTR id, DWORD state)
{
    UNREFERENCED_PARAMETER(self);
    UNREFERENCED_PARAMETER(id);
    UNREFERENCED_PARAMETER(state);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE notification_device(IMMNotificationClient *self, LPCWSTR id)
{
    UNREFERENCED_PARAMETER(self);
    UNREFERENCED_PARAMETER(id);
    return S_OK;
}

/**
 * Windows calls this on its own thread and must not be kept waiting, so the capture loop compares the
 * devices. Only the console role is watched: it is the one opened here and the one Chromium plays to.
 */
static HRESULT STDMETHODCALLTYPE notification_default(IMMNotificationClient *self, EDataFlow flow, ERole role, LPCWSTR id)
{
    UNREFERENCED_PARAMETER(self);
    UNREFERENCED_PARAMETER(id);
    if (role == eConsole && (flow == eCapture || flow == eRender)) SetEvent(default_changed);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE notification_property(IMMNotificationClient *self, LPCWSTR id, const PROPERTYKEY key)
{
    UNREFERENCED_PARAMETER(self);
    UNREFERENCED_PARAMETER(id);
    UNREFERENCED_PARAMETER(key);
    return S_OK;
}

static IMMNotificationClientVtbl notification_vtbl = {
    notification_query, notification_add_ref, notification_release, notification_state,
    notification_device, notification_device, notification_default, notification_property,
};
static IMMNotificationClient notification = {&notification_vtbl};

/** Sets the stop event once stdin reaches EOF, which is how the parent asks capture to stop. */
static DWORD WINAPI watch_stdin(LPVOID stop)
{
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char buffer[256];
    DWORD got = 0;
    while (ReadFile(in, buffer, sizeof buffer, &got, NULL) && got > 0) {
    }
    SetEvent((HANDLE)stop);
    return 0;
}

/**
 * Opens the same default microphone again after Windows invalidated the stream, which a change of the
 * device's format or a Bluetooth headset switching to its hands-free profile does. Another default device
 * gets a new process instead, and changes past the limit end capture.
 */
static int follow_change(IMMDeviceEnumerator *enumerator, Capture *capture, HANDLE ready, ULONGLONG *changes, int *count, int limit, ULONGLONG window)
{
    if (defaults_changed(enumerator, capture)) {
        say("audio device changed");
        return EXIT_DEVICE_CHANGED;
    }
    const ULONGLONG now = GetTickCount64();
    int kept = 0;
    for (int i = 0; i < *count; i++) {
        if (now - changes[i] < window) changes[kept++] = changes[i];
    }
    changes[kept++] = now;
    *count = kept;
    if (kept > limit) {
        say("audio configuration keeps changing");
        return EXIT_KEEPS_CHANGING;
    }
    say("audio configuration changed; capturing again");
    close_capture(capture);
    const int status = open_capture(enumerator, capture);
    if (status == EXIT_NO_ECHO_CANCELLATION) return status;
    if (status != EXIT_OK || !start_capture(capture, ready)) return EXIT_DEVICE_CHANGED;
    return EXIT_OK;
}

static int capture_until_stopped(IMMDeviceEnumerator *enumerator, int limit, ULONGLONG window)
{
    Capture capture;
    ULONGLONG changes[MAX_CHANGE_LIMIT + 1];
    int count = 0;
    HANDLE stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    HANDLE ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (stop == NULL || ready == NULL || CreateThread(NULL, 0, watch_stdin, stop, 0, NULL) == NULL) {
        say("cannot create the events or the stdin thread (error %lu)", GetLastError());
        return EXIT_NO_DEVICE;
    }
    int status = open_capture(enumerator, &capture);
    if (status != EXIT_OK) return status;
    if (!start_capture(&capture, ready)) return EXIT_NO_DEVICE;

    DWORD task = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &task);
    if (mmcss == NULL) say("the capture thread runs without MMCSS (error %lu)", GetLastError());
    HANDLE events[3];
    events[0] = stop;
    events[1] = default_changed;
    events[2] = ready;
    for (;;) {
        DWORD signalled = WaitForMultipleObjects(3, events, FALSE, READ_TIMEOUT_MS);
        if (signalled == WAIT_OBJECT_0) {
            status = EXIT_OK;
            break;
        }
        if (signalled == WAIT_OBJECT_0 + 1) {
            if (!defaults_changed(enumerator, &capture)) continue;
            say("audio device changed");
            status = EXIT_DEVICE_CHANGED;
            break;
        }
        if (signalled != WAIT_OBJECT_0 + 2 && signalled != WAIT_TIMEOUT) {
            say("waiting for audio failed with error %lu", GetLastError());
            status = EXIT_NO_DEVICE;
            break;
        }
        HRESULT hr = drain(&capture, out);
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
            status = follow_change(enumerator, &capture, ready, changes, &count, limit, window);
            if (status != EXIT_OK) break;
        } else if (FAILED(hr)) {
            say("reading from %s failed (0x%08lx)", capture.microphone, (unsigned long)hr);
            status = EXIT_NO_DEVICE;
            break;
        }
    }
    if (capture.client) IAudioClient2_Stop(capture.client);
    close_capture(&capture);
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    return status;
}

static int parse_count(const char *text, unsigned long max, unsigned long *value)
{
    char *end = NULL;
    *value = strtoul(text, &end, 10);
    return end != text && *end == '\0' && *value >= 1 && *value <= max;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("asist-mic %s\n", MIC_VERSION);
        return EXIT_OK;
    }
    const int checking = argc == 2 && strcmp(argv[1], "--check") == 0;
    unsigned long limit = 0;
    unsigned long seconds = 0;
    if (!checking && (argc != 3 || !parse_count(argv[1], MAX_CHANGE_LIMIT, &limit) || !parse_count(argv[2], 3600, &seconds))) {
        say("usage: asist-mic --version | --check | <change-limit 1-%d> <window-seconds>", MAX_CHANGE_LIMIT);
        return EXIT_NO_DEVICE;
    }

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        say("COM did not start (0x%08lx)", (unsigned long)hr);
        return EXIT_NO_DEVICE;
    }
    IMMDeviceEnumerator *enumerator = NULL;
    hr = CoCreateInstance(&ENUMERATOR_CLASS, NULL, CLSCTX_ALL, &ENUMERATOR_INTERFACE, (void **)&enumerator);
    if (FAILED(hr)) {
        say("cannot reach the audio devices (0x%08lx)", (unsigned long)hr);
        return EXIT_NO_DEVICE;
    }
    int status;
    if (checking) {
        status = check(enumerator);
    } else {
        default_changed = CreateEventW(NULL, FALSE, FALSE, NULL);
        hr = default_changed ? IMMDeviceEnumerator_RegisterEndpointNotificationCallback(enumerator, &notification) : E_FAIL;
        if (FAILED(hr)) {
            say("cannot watch the default devices (0x%08lx)", (unsigned long)hr);
            return EXIT_NO_DEVICE;
        }
        status = capture_until_stopped(enumerator, (int)limit, (ULONGLONG)seconds * 1000);
        IMMDeviceEnumerator_UnregisterEndpointNotificationCallback(enumerator, &notification);
    }
    IMMDeviceEnumerator_Release(enumerator);
    CoUninitialize();
    return status;
}
