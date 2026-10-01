---
title: Voice engine
description: Listen and speak on this computer, or leave it to Gemini Live.
sidebar:
  order: 5
---

Under "Voice engine" in "Conversation", choose what listens and speaks. The default combines speech recognition on this computer, the conversation model, and reading aloud on this computer.

When you choose "Speech recognition on this computer + model + speech" and the speech recognition or the speech doesn't work yet, it shows under "Needs preparing" on "Overview" and next to "Voice" in the list of pages. If you chose "Talk in real time with a voice model" or "Text only" in the first setup, it skipped preparing both. Prepare speech recognition with "Prepare" under "Speech recognition" on the "Voice" page; until then the microphone can't be used. When the speech engine is "No speech (replies as text only)", replies appear as text only. To hear them, choose an engine under "Speech" on the "Voice" page.

When you choose Gemini Live, the microphone audio goes straight to Google, and ASIST speaks in Google's voice. The model handles backchannels, listening, and deciding when you have finished speaking or interrupted. Speech recognition and reading aloud on this computer, the bridge phrase and MaAI are not used, so you can talk by voice even on Windows without a discrete GPU. Changing the engine, "Model", "Voice" or "Close the session after" turns the microphone off, so turn it on again.

Gemini decides by itself and calls ASIST's tools. ASIST runs the tools, so the confirmation screen for writes still appears. The conversation model is not used. It needs a Google API key, and costs about $0.005 per minute of audio input and $0.018 per minute of output.

A session opens when you start talking, and closes once the conversation has stopped for the time set in "Close the session after" (90 seconds by default). You aren't charged while it is closed. When you speak again, ASIST holds the last 3 seconds of audio while it reopens the session, so the start of what you say isn't lost. With "Show at the top of the screen" turned on in [Appearance](/en/docs/settings/appearance/), the top of the screen shows the connection, the time to respond, the minutes in the session and the estimated cost. Turning the microphone off closes the session.

Choose a voice on the "Voice" page from the ones Google offers, and use "Play sample" to hear a bundled sample. Playing a sample doesn't use the API.

With Gemini Live, the conversation log records transcripts of the input and the output as they were actually heard. Memory curation works from this log, so it works from the same material whichever engine you use.

![The Conversation page in the settings, with the voice engine and the models](/screens/en/settings-conversation.webp)
