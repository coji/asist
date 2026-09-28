---
title: What is bundled
description: The software and data that come with the app.
sidebar:
  order: 3
---

## Software

| Software | Obtained from | License |
|---|---|---|
| uv | Astral's releases on GitHub. It is checked by hash before it is bundled. | MIT or Apache-2.0 |
| git | On a Mac, the source tarball from kernel.org. After a hash check, only the parts needed for local operations are compiled. The source is not modified. On Windows, MinGit as Git for Windows publishes it. After a hash check, it is bundled without the parts ASIST does not use. | GPL-2.0 |

The license texts of both are included in the app. For git, the [Release](https://github.com/nyosegawa/asist/releases) of each version of ASIST carries the source tarball of the same git version, and for the git on Windows, the source of the same version of Git for Windows.

## Data

| Data | How it is made |
|---|---|
| The weather region table (47 prefectures and 1,919 municipalities, matched to forecast areas and weather stations) | From the Japan Meteorological Agency's constant files and the list of municipalities from the Geospatial Information Authority of Japan |
| Qwen3-TTS backchannel audio (nine voices) | Synthesized with Qwen3-TTS, then trimmed and bundled. |
| Voice samples for Live | Synthesized with the provider's TTS and bundled. |

The list of licenses for the models and data ASIST uses is also shown under "About" in the app's settings.
