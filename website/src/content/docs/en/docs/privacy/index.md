---
title: Where your data is kept
description: What ASIST keeps on this computer, and where.
sidebar:
  order: 2
---

ASIST sends no data to its developer. The settings and data are in the following folders. Reinstalling the app doesn't remove them.

| OS | Settings and data | App log |
|---|---|---|
| macOS | `~/Library/Application Support/asist/` | `~/Library/Logs/asist/` |
| Windows | `%APPDATA%\asist\` | `%APPDATA%\asist\logs\` |

The folder of settings and data holds the following.

| Location | Contents |
|---|---|
| `settings.json` | Settings |
| `api-keys.json` | Encrypted API keys |
| `memory/` | Memory (Markdown, with its history in Git) |
| `conversations/` | Conversation logs |
| `tasks.json` | Tasks |
| `notes/` | Notes (one Markdown file per note) |
| `mail-cache.sqlite`, `mail-secrets.json` | Fetched mail, and encrypted passwords |
| `api-usage.json` | Usage and cost of the paid APIs (daily totals) |
| `joblogs/` | Logs of Agent jobs |
| `python/`, `uv-cache/` | The Python that uv downloaded, and the package cache |
| `speech-models/` | The models for speech recognition and Qwen3-TTS |
| `embedding-runtime/`, `vap-runtime/` | Python environments for searching the memory by meaning, choosing the kind of backchannel, and MaAI |

The app log is kept in the app log folder in the table above, one file per day.

Earlier versions of ASIST created a Python environment in `mlx-audio-runtime/` (macOS) or `cuda-speech-runtime/` (Windows) for speech recognition and reading aloud, and downloaded the models into the standard Hugging Face cache. The current version uses none of these, so you can delete them. The Hugging Face cache is `~/.cache/huggingface/hub/` on macOS and `%USERPROFILE%\.cache\huggingface\hub\` on Windows. Other apps use the same place, so delete only these folders, which ASIST downloaded:

- `models--mlx-community--Qwen3-ASR-1.7B-8bit`
- `models--mlx-community--whisper-large-v3-turbo-asr-fp16`
- `models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit`
- `models--Qwen--Qwen3-ASR-1.7B-hf`
- `models--Qwen--Qwen3-ASR-0.6B-hf`

The files of new versions that the automatic update downloads are kept in `~/Library/Caches/asist-updater/` on macOS and `%LOCALAPPDATA%\asist-updater\` on Windows, where a copy of the installer is kept as well. Uninstalling ASIST doesn't remove them.

## API keys and passwords

API keys and mail passwords saved in the settings are encrypted with Electron's safeStorage and are never written as plain text. If encryption isn't available, ASIST doesn't save them and shows an error instead. How the encryption key is protected differs by OS.

- On macOS, the key is kept in the keychain. If an app other than ASIST tries to read it, macOS asks you first.
- On Windows, the key is encrypted with DPAPI, tied to your Windows user account, and kept in `Local State` in the folder of settings and data. Any program running as the same Windows user can decrypt this key and take out the saved keys. What this encryption prevents is someone reading them when only the files reach another user or another computer.

Child processes such as the Agent CLI, the Python workers and the speech engines receive no provider's API key.

## App log

The app log holds the app's output and the warnings and errors from the screen. The values of keys, tokens and passwords, and the API keys you saved, are masked before they are written, so you can attach the log to a bug report as it is. The text of your conversations is not written. Files older than 14 days are deleted, and the file for one day is limited to 20MB. You can open this folder from "App log" in "Conversation" in the settings.

## Settings file versions

JSON files such as the settings, tasks, timers and jobs carry the version of their format. When a newer ASIST opens a file in an older version, it first keeps the original file in the same place as `<name>.v<version>.json`, then moves the file to the current format. If a file was written by a newer ASIST than the one you are running, or is damaged and can't be read, ASIST shows the file's location and the reason and stops, leaving the original file untouched.

What ASIST sends out is listed in [What ASIST sends out](/en/docs/privacy/external/).

How ASIST and this site handle your data is summarized in the [Privacy Policy](/en/privacy/).
