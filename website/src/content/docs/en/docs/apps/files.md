---
title: Files
description: See output files and the contents of folders on cards.
sidebar:
  order: 8
---

You see files on file cards. Markdown appears as a document, CSV as a table, images as they are, and a folder as a list of its contents. Word, Excel, PowerPoint, PDF, code, JSON, Jupyter notebooks, video and audio files can be shown as well. For a type the card can't show, such as a zip file, it shows only the name and the size. Several files appear as a list; click one to read that item in the enlarged view, and move to the previous or next one from there.

A folder with many entries lists its first 200 and gives the total in its heading. To see the rest, use "Show in Finder" on a Mac, or "Show in File Explorer" on Windows.

Word, Excel, PowerPoint and PDF files are read whole before they are drawn. Reading a large one would stop the app, so a file over the limit below isn't read, and the card says "This file is too large to show here". To see its contents, use "Show in Finder" ("Show in File Explorer" on Windows) and open it in its usual app.

| Type | Limit |
| --- | ---: |
| Word | 16 MB |
| Excel | 8 MB |
| PowerPoint | 32 MB |
| PDF | 256 MB |
| Audio waveform | 8 MB |

Audio plays at any size. Over the limit, only its waveform is left out.

HTML appears as a page, and "Source" switches to the original HTML. The page's scripts run, and the page loads CSS, images and scripts from the same folder, as well as resources over https. The page runs in a frame that is cut off from the app, so it can't touch the app's screens or features, and it can't read the contents of other files. When a link in the page tries to go to another site, the site doesn't open in the app; "Open in browser" hands it to your default browser.

Only files under a job's working directory, the memory folder, and the "Folders ASIST may open" on the "Agent" page of the settings can be opened.
