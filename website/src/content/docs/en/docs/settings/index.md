---
title: The settings screen
description: How to open the settings, the overview, the cost estimates, and About.
sidebar:
  order: 1
---

Open the settings with the gear icon in the Dock. The list of pages is on the left, and the items of the selected page are on the right. After "Overview", the list is divided under the headings "Assistant", "Features" and "General". Below the name of each page, one line gives its current settings. When something on a page is turned on but doesn't work yet, that line turns into a warning. A feature you have turned off is never a warning.

## Overview

The settings open on "Overview".

- "Current setup" shows the speech recognition, the conversation model and the speech. Select one to open its page.
- "Needs preparing" lists what is turned on but doesn't work yet. Each row holds the step that fixes it, such as downloading a model, the installation guide for the Agent CLI, or registering an API key.
- "Features you can add" lists semantic search, turn-taking (MaAI) and in-browser Whisper when they are off. The conversation works without them. "Prepare and turn on" downloads what the feature needs and turns it on.

You can also download a model in the row of the item that uses it: speech recognition and speech on the "Voice" page, and semantic search on the "Memory" page. The progress appears in the row of the button you pressed. Only one download runs at a time.

![The Overview page in the settings, with the current setup and what needs preparing](/screens/en/settings-overview.webp)

## API costs

"API costs" shows, day by day, what the conversation model, GPT-Live and Gemini Live, and Claude Code jobs cost. It is an estimate that ASIST calculates from your usage and each provider's published prices (as of 2026-09-23), and it may not match what you are actually billed. Codex doesn't report amounts, so it isn't included. Speech recognition and reading aloud run on this computer, so they cost nothing.

## About

The last page, "About", shows the version of ASIST, the update status, the licenses, the app log folder, and a list of the models and outside data ASIST uses. Each row of the list shows the provider, the license and a link to the provider's page. Once a new version has finished downloading, "Restart now" switches to it. Updating on Windows is covered in [Updating and uninstalling](/en/docs/start/update/).
