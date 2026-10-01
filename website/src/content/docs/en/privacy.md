---
title: Privacy Policy
description: How the ASIST desktop app and this site handle your information.
editUrl: false
tableOfContents:
  maxHeadingLevel: 2
---

Last updated: October 1, 2026

This privacy policy explains how ASIST, a desktop app for Mac and Windows, and this site (asist-agent.com) handle your information.

## Who publishes ASIST and how to reach us

ASIST is developed by Sakasegawa as an individual and published for free as open source under the MIT License.

Questions about this policy or about how your data is handled are welcome by email at [nyosegawa@gmail.com](mailto:nyosegawa@gmail.com) or in the repository's [GitHub Issues](https://github.com/nyosegawa/asist/issues). Issues are public, so please send questions that include personal information or the contents of your calendar by email.

## ASIST has no server of its own

ASIST has no server of its own that receives your data. Its developer receives no data from the app. The app sends no usage statistics and no crash reports on its own.

ASIST connects directly from your computer to the outside services you set up. What goes where is listed under [What ASIST sends to outside services](#what-asist-sends-to-outside-services).

## What stays on your computer

Your settings, conversation logs, memory, notes, tasks, fetched mail and API keys are kept on your computer, in the following folders. Uninstalling the app leaves them in place; to remove them, delete the folders.

| OS | Settings and data | App log |
|---|---|---|
| macOS | `~/Library/Application Support/asist/` | `~/Library/Logs/asist/` |
| Windows | `%APPDATA%\asist\` | `%APPDATA%\asist\logs\` |

- The API keys and mail passwords you save in the settings are encrypted with the operating system and never written in plain text. The encryption key is kept in the Keychain on macOS, and tied to your Windows user with DPAPI on Windows.
- The conversation log records what you said, ASIST's replies, and tool calls and their results, in one file a day. Files older than "Days the conversation log is kept" under "Conversation" in the settings (90 days by default) are deleted when the date changes.
- Memory and notes are Markdown files, and stay until you delete them.
- The app log never contains the text of your conversations. Keys, tokens and passwords are masked before they are written, and files older than 14 days are deleted.

What each file holds is described in [Where your data is kept](/en/docs/privacy/).

## What ASIST sends to outside services

ASIST sends only what a feature you use needs, and only to the following services. Paid APIs are reached with your own API keys. What is sent is handled under each service's own terms and privacy policy.

| Sent to | What is sent | When |
|---|---|---|
| The provider of the conversation model you chose (Anthropic, OpenAI, Google, Cerebras) | The text of the conversation, the prompt, the parts of memory that relate to the conversation, and tool results | Every turn of a conversation |
| The provider's built-in web search (Anthropic, OpenAI, Google) | The search terms the conversation model decides on | When the conversation model searches |
| The Google Live API | Microphone audio, the recent conversation history, and tool results | Only when you choose Gemini Live as the voice engine |
| The service behind the codex or claude CLI | The job's prompt and the contents of the working folder the CLI reads; for memory curation, the conversations up to the previous day (what you said, ASIST's replies, and tool names and inputs) | When a job you approved runs, and during the daily memory curation |
| Weather, world clock, exchange rates, news and maps (the Japan Meteorological Agency, Open-Meteo, ExchangeRate-API, Google News, Google's Maps Embed API) | Place names or latitude and longitude, a currency, topic words, and the place or route to show on the map | When a card is shown |
| The mail servers you set up (IMAP and SMTP) | Your login details, the mail you pressed "Send" for, and actions such as marking as read or archiving | When mail is fetched, sent or acted on |
| The Google Calendar API | See [Google user data](#google-user-data) | When ASIST is connected to Google Calendar |
| Hugging Face, GitHub, PyPI and similar | Requests for the files being downloaded, with a User-Agent naming ASIST and its version | When downloading models that run on your computer, Python, or a new version of ASIST |

Speech recognition, voice activity detection, backchannel decisions and memory search run only on your computer, and send out neither audio nor text. Speech from VOICEVOX, AivisSpeech and Qwen3-TTS is also produced on your computer.

The full list, service by service, is in [What ASIST sends out](/en/docs/privacy/external/).

## Google user data

This section describes how ASIST handles the data it receives from Google when it is connected to Google Calendar. The calendar of ASIST reads and writes Google Calendar alone, on a Mac and on Windows.

### Scopes ASIST requests and why

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

  ASIST reads the list of your calendars (each calendar's name, ID, time zone and whether you can write to it), so that you can choose which calendars to show and which one new events are saved to. It reads the email address of the connected Google account from the ID of your primary calendar, and shows it in the settings. ASIST does not change your list of calendars.

- `https://www.googleapis.com/auth/calendar.events`

  ASIST reads your events and shows them in the calendar screen and in conversation. It uses each event's title, start and end, time zone, location, description, whether it repeats, and whether it has attendees; it does not use the attendees' names or email addresses. ASIST creates, changes and deletes events when you ask. Before any change is made, whether you asked in conversation or on the screen, ASIST shows it in a confirmation dialog and makes it only after you approve.

### Sharing, transfer and disclosure of Google user data

ASIST never sends data received from Google to ASIST's developer or to an ASIST server. ASIST has no server, and its developer never receives this data.

ASIST sends data received from Google only to the following recipients you set up, and only to answer what you asked ASIST to do. Each one is reached directly from your computer, with your own API key or sign-in.

| Recipient | What is sent | When |
|---|---|---|
| The one conversation model provider you chose in the settings: Anthropic (Claude API), OpenAI (OpenAI API), Google (Gemini API) or Cerebras (Cerebras API) | The title, time, location and description of the events needed for the answer, and the name of their calendar | When you ask about your schedule in conversation, or ask ASIST to add or change an event |
| The Live API you chose as the voice engine: Google (Gemini Live API) | The same as above | Only when Gemini Live is chosen and the conversation deals with your events |
| The codex CLI (OpenAI) or the claude CLI (Anthropic) you signed in to | The conversations up to the previous day: what you said, ASIST's replies, and tool names and inputs. On a day you talked about events or added or changed them, this includes those events. For a job you approved, any event details written into the job's instructions | During the daily memory curation, and when a job you approved runs |
| The conversation model provider's built-in web search, and the map and weather cards (Google's Maps Embed API, the Japan Meteorological Agency, Open-Meteo) | Search terms or place names the conversation model takes from an event, such as its location | When you ask for it, for example to look up an event's venue or show its map or weather |
| The Google Calendar API | The creation, change or deletion of an event you approved | When you approve it in the confirmation dialog |

Each recipient handles what it receives under its own terms and privacy policy. Whether a provider uses the events it receives to train its models depends on its terms and on the plan and settings of the API key or account you use.

ASIST does not share, transfer or disclose data received from Google to any other person or service. It does not sell the data, give it to anyone for advertising, or give it to data brokers.

### How Google user data is protected

- **Encryption in transit**: every connection to Google, to the conversation model providers and to the Live APIs uses HTTPS (WSS for the Live APIs), encrypted with TLS.
- **Sign-in**: signing in to Google uses OAuth 2.0 for installed apps (RFC 8252) with PKCE (RFC 7636) and a state check. The result of the sign-in comes back to a listener on 127.0.0.1 of your computer that exists only during the sign-in, and passes through no outside server.
- **Token storage**: the refresh token is encrypted with the operating system (the Keychain on macOS, DPAPI on Windows) and never written in plain text. The access token is kept only in memory and never written to disk. Token values are masked before anything is written to the app log.
- **Minimum scopes**: ASIST requests only the two scopes above. It does not touch Gmail, contacts or any data other than your calendars.
- **No copy of your events**: events are read from Google each time they are used, and used in memory. ASIST does not save a copy of your events to a file. When a conversation deals with your events, what was said stays in the conversation log like any other conversation. The conversation log is kept in your user account's folder, which other users of the same computer cannot read under the operating system's default permissions, and is deleted after the number of days set in the settings (90 days by default).
- **Approval before writing**: no event is created, changed or deleted until you approve it in the confirmation dialog.
- **No human access**: no person reads this data, ASIST's developer included.
- **Open source**: you can check how ASIST does all of this in its source code on [GitHub](https://github.com/nyosegawa/asist).

### What ASIST does not do

- ASIST does not sell data received from Google.
- ASIST does not use it for advertising, and does not pass it to anyone for advertising.
- ASIST does not use it to develop, improve or train generalized AI or machine learning models.
- No person reads this data, ASIST's developer included; the developer never receives it.

ASIST's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

### Revoking access

- When you sign out of Google in ASIST, ASIST asks Google to revoke its access, deletes the sign-in tokens it kept on your computer, and stops reading your Google Calendar.
- You can also revoke access on Google's side at any time: in your Google Account, open Security, then your connections to third-party apps and services ([myaccount.google.com/connections](https://myaccount.google.com/connections)), choose ASIST and delete its access.

## This site

This site (asist-agent.com) uses Google Analytics, which sets cookies, to count visits. How Google handles the data it collects is described in [How Google uses data](https://policies.google.com/technologies/partner-sites?hl=en). The site is served by Cloudflare. It has no forms to fill in and no accounts.

## Children

ASIST is not made for children under 13. ASIST's developer collects no information about its users, whatever their age. The outside services ASIST connects to set their own age requirements in their terms.

## Source code

ASIST is open source, and its source code is on [GitHub](https://github.com/nyosegawa/asist). You can read there how ASIST actually does what this policy describes.

## Changes to this policy

When this policy changes, this page is updated along with the date at the top. Earlier versions can be seen in the history of the GitHub repository.
