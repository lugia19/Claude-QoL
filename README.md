# Claude QoL

This extension adds a bunch of QOL/Utility features to claude.ai, like Search, Navigation, TTS, forking, exporting, etc.

Available on:
- [Firefox (Desktop+Mobile)](https://addons.mozilla.org/firefox/addon/claude-qol/)
- [Chrome](https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob)
- The desktop client - Via [Claude-WebExtension-Launcher](https://github.com/lugia19/Claude-WebExtension-Launcher)

# Features
## Forking+Compacting
<img width="616" height="887" alt="image" src="https://github.com/user-attachments/assets/dba9c261-5f09-4900-837b-28a2e039cfe2" />

Allows you to start a new chat by forking an existing one. The new chat will include all the content of the old one up to that point (or a summary of the content up to that point) and optionally any attachments.

## Chat Search
<img width="710" height="298" alt="image" src="https://github.com/user-attachments/assets/fb240eca-68ac-4236-81b1-b6fbbdcd28a4" />

Allows you to search for text in the entire chat, including all branches.

## Speech to text
<img width="428" height="364" alt="image" src="https://github.com/user-attachments/assets/8db85861-6644-487d-aea0-93ab29b468b7" />
<img width="741" height="93" alt="image" src="https://github.com/user-attachments/assets/6c77a230-e71f-46cf-b024-f5e97045cf93" />

Uses groq, OAI or your browser to recognize speech from your microphone and send it as text.
Requires bringing your own API key (Or being on chrome for the browser option).

## Text to speech
<img width="432" height="650" alt="image" src="https://github.com/user-attachments/assets/b30136e6-1903-466b-95b8-13d0fa9879b8" />

Uses elevenlabs, OAI or your browser to speak messages out loud. Includes options for auto-speaking.
Requires bringing your own API key if not using the free native option.

### Actor mode
<img width="853" height="515" alt="image" src="https://github.com/user-attachments/assets/076f5827-6e0f-496c-8219-f30b3662010c" />

This allows you to assign text from specific characters to specific voices.

## Chat Navigation
<img width="546" height="423" alt="image" src="https://github.com/user-attachments/assets/f8fc08dc-bdd0-4798-9dd8-b9656574defb" />

Lets you save points in the conversation tree and navigate back to them.

<img width="1092" height="146" alt="image" src="https://github.com/user-attachments/assets/85e747f2-2fe4-4101-b452-0b4e61e60ee3" />

Lets you hop between your messages quickly, without scrolling.


## Exporting and importing
<img width="549" height="642" alt="image" src="https://github.com/user-attachments/assets/fe770c3a-d306-4a84-bc1d-b04fe3bc1469" />

You can export a chat (or project) to various formats. Zip, HTML, JSON, etc.

You can also IMPORT a chat from a ZIP format export, and it will appear as though all the messages are actually there.

## Preferences switcher
<img width="269" height="80" alt="image" src="https://github.com/user-attachments/assets/ce6583f6-3d28-43cc-bd89-3ab0b98d93e0" />
<img width="878" height="384" alt="image" src="https://github.com/user-attachments/assets/910abd61-a311-4a45-ac58-20eb23c058f0" />

Adds a dropdown to the sidebar to let you switch between different preferences. You can create/edit presets in the settings.

## Copy as Rich Text
Adds a "Copy as rich text" button next to the existing copy button on content blocks. Converts markdown to formatted HTML so it pastes with proper bold, italic, lists, headings, etc. into email clients (Outlook, Gmail), Google Docs, and other rich text editors.

## The hidden "do not delete" skill

You may notice a disabled skill on your account named `qol-encryptionkey-do-not-delete` (the extension hides it from the in-app skills list, but it exists on your account). This is created and managed automatically — please don't delete it.

Its only purpose is to store an encryption key at the account level. Some features keep a local cache of conversation content in the browser (IndexedDB) - the export cache and forking's carried-over messages - and that cache is encrypted at rest using this key. Storing the key as an account-level skill means it travels with your account rather than being tied to a single browser, which lays the groundwork for future cross-device sync of that cached data.

If you do delete it, nothing breaks — the extension simply generates a new key and rebuilds the local cache from scratch (the old encrypted cache becomes unrecoverable and is wiped).

# Building from source
Shared code lives in the [claude-ext-common](https://github.com/lugia19/claude-ext-common) submodule, so clone with `git clone --recurse-submodules` (or run `git submodule update --init` in an existing clone). Then run `build.bat`, which produces the Chrome, Firefox and Electron zips in `web-ext-artifacts/`.
