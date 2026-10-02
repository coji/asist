---
title: Conversation models
description: The conversation model, the bridge phrase model and the API keys.
sidebar:
  order: 4
---

Under "Conversation", choose the conversation model and the model for the bridge phrase. The bridge phrase is a short phrase that ASIST prepares while you are still talking and says before the main answer. When you turn off "Bridge phrase" on the "Voice" page, ASIST doesn't say it and doesn't use the bridge phrase model either. While it is off, ASIST also doesn't fill the wait with a short line such as "ちょっと見てみますね。" ("Let me have a look.") when a search or a tool takes a while in a Japanese conversation. Backchannels in a Japanese conversation are turned on and off separately, with "Backchannels".

Save an API key for each provider on the "API keys" page. When the provider of a model in use has no key, it shows below the models in "Conversation" and on "Overview". Before saving a key, ASIST checks that it can get the list of models from that provider's API. You can't choose a model from a provider that has no key. Keys are stored encrypted, with a key from the keychain on a Mac and with a key tied to your Windows user account (DPAPI) on Windows.

Next to the model, you can choose the depth of thinking. The default is the shallowest setting, so that a voice conversation doesn't keep you waiting. With a deeper setting, it can take more than ten seconds before the answer starts.

Web search uses the provider's built-in search, so it isn't available with Cerebras models, which have no built-in search. The conversation history is stored in a form that doesn't depend on the provider, so the conversation carries on even if you switch models partway through.

The list of models you can choose is in [Models ASIST uses](/en/docs/reference/models/).

![The Conversation page in the settings, with the voice engine and the models](/screens/en/settings-conversation.webp)
