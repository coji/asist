---
title: What ASIST sends out
description: What ASIST sends out, and what it receives from outside.
sidebar:
  order: 3
---

This is a list of what ASIST sends out and what it receives from outside. When you click a link in the news or in search results, it opens in your default browser.

## Conversation and voice

| Sent to | What is sent | What comes back |
|---|---|---|
| The provider of the conversation model you chose (Anthropic, OpenAI, Google, Cerebras) | The text of the conversation, the prompt, the parts of memory that relate to the conversation, and tool results | Replies and tool calls |
| The provider's built-in web search (Anthropic, OpenAI, Google) | The search terms the conversation model decides on | Search results |
| The OpenAI or Google Live API (only when you choose it as the voice engine) | Microphone audio, the recent history, and tool results | Audio and transcripts |
| The service behind the codex or claude CLI | The job's prompt, the contents of the working folder that the CLI reads, and for memory curation, the conversation logs | The results of the work |

Speech recognition, voice activity detection, backchannel decisions and memory search run only on this computer, and send out neither audio nor text.

## Data for the cards

| Data | Source | What is sent |
|---|---|---|
| Weather (region is Japan) | Forecasts, AMeDAS observations and weather distribution forecasts from the [Japan Meteorological Agency](https://www.jma.go.jp/bosai/) | Codes of the forecast area and the weather station |
| Weather (region outside Japan) | Forecasts and geocoding from [Open-Meteo](https://open-meteo.com) | The place name, latitude and longitude |
| World clock locations | Geocoding from Open-Meteo | The city name |
| Exchange rates | ExchangeRate-API (`open.er-api.com`) | The base currency |
| News | Google News RSS | The topic, the language and the region |
| Map | Google's Maps Embed API | The words for the place or the route |

Data from the Japan Meteorological Agency is shown with its source and a note that it has been processed ([JMA terms of use](https://www.jma.go.jp/jma/kishou/info/coment.html)). Open-Meteo is licensed under CC BY 4.0, and its free API is limited to non-commercial use and to a number of requests (such as 10,000 a day). ASIST uses no key, so requests are counted per connecting IP address, and the limit applies to each person, not to the app as a whole.

When fetching card data and models, ASIST sends `ASIST/<version> (https://github.com/nyosegawa/asist)` as the User-Agent.

## Your accounts

| Data | Connects to | Notes |
|---|---|---|
| Mail | The IMAP and SMTP servers of the accounts you set up | Fetched mail is kept on this computer. |
| Calendar | The Google Calendar API (`www.googleapis.com`), and getting and revoking the sign-in tokens (`oauth2.googleapis.com`) | You sign in on Google's page (`accounts.google.com`), which opens in your browser. ASIST reads and writes the events of the Google account you signed in to when it uses them. The sign-in is stored encrypted on this computer. |

## Models, runtimes and updates

| What is downloaded | Source |
|---|---|
| Models that run on this computer | Hugging Face (`huggingface.co`). Only the CPC weights come from `dl.fbaipublicfiles.com` |
| Python | The bundled uv downloads it from python-build-standalone on GitHub and checks it by hash. |
| Python packages | The bundled uv downloads them from PyPI and checks them against pinned hashes. |
| New versions of ASIST | GitHub Releases (`github.com/nyosegawa/asist`) |
