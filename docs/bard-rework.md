# QoL on the merged-experience API: reference

Findings from the "big questions" exploration (2026-10-08 to 2026-10-09), all verified live in Chrome
against a merged account (with Claude Usage Tracker loaded), plus the decisions taken. This is the
spec the rework branch builds against. Raw API notes (calls, event shapes, compaction, context
costs) live in `common/scripts/bard/README.md`; this file covers what QoL can do with that API and
how.

## Decisions

| # | Decision |
| --- | --- |
| D1 | **The rework is merged-only.** No legacy code paths in the new code. **Revised 2026-10-09: reads stay on the legacy tree GET** (`ClaudeConversation.getData`), like the tracker. It still answers for merged chats with full fidelity (text attachments' `extracted_content`, raw `tool_use.input`, pre-merge `compaction_summary`), which `ReadConversation` lacks. A `ReadConversation` adapter is the documented contingency if the GET ever starts failing (gaps: README "Legacy JSON still answers" and the comparison table). Interception and our own actions use the new API. |
| D2 | **Process:** a long-lived rework branch, with PRs into that branch, merged to `main` when ready, timed to the rollout. The current release keeps serving legacy accounts until then. |
| D3 | The reworked version **detects legacy accounts** (RPC 403, or no `StreamTimeline`) and shows a notice instead of half-working features. |
| D4 | **Protobuf toolkit in common** (`net.js` + `bard-schema.js`, versioned): decode with unknown fields kept, then edit, then encode. Fields are referenced **by name**, never by number. See [Toolkit](#toolkit-common). |
| D5 | **Message identity = `data-turn-key`**, plus the tree rule for `-hub-reply` keys. **Zero React internals** in production. |
| D6 | **Full-load patch** (all messages loaded at page load), as a toggle in the overall Settings panel, **default on**. |
| D7 | Navigation's "continue on an old branch" UX: our own banner next to claude.ai's "earlier version" banner (see [Branches](#branches-and-navigation)). |
| D8 | **Forking stays QoL's own fork** (new chat, chatlog/summary attachments, phantoms), verbatim or summarized: clicking our fork button means our fork. The native fork is not used. Upgraded chats get a warning in the fork dialog that files created in the cloud environment won't come along. |

## Wire basics

- Endpoint: `POST /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/<Method>`.
- **Unary calls** (`PerformAction`, `ReadConversation`, `ReadConversationHistory`): `content-type: application/proto` (or `application/json` with camelCase fields, which works for reads).
- **Streaming** (`StreamTimeline`): `application/connect+proto`. Frames are `flags(1) + length(4, BE) + payload`, where flag `0x01` = gzip and `0x02` = end-of-stream (JSON trailers). We may re-emit frames uncompressed (flags 0); the client accepts them.
- **Headers for our own calls from MAIN:** `content-type`, `connect-protocol-version: 1`, `x-organization-uuid: <org>`, `anthropic-client-platform: web_claude_ai`.
  - These endpoints check `Origin`. Calls from the page are fine; extension/background contexts get 403 unless a declarativeNetRequest rule rewrites `Origin`.
- **Our own `PerformAction`:** `{ header: { mutation_id: { session_id: 'sess_<ours>', version: 1 }, conversation_id, display_language }, <action> }`.
  - A 200 only means accepted. **Success or failure arrives as a `mutation_ack` on the stream** (e.g. `stale_parent`, `invalid_leaf_target`).
- **Our own `StreamTimeline`:** body = one frame holding `{ conversation_id, display_language }`. The first frame is the snapshot.
- Merge semantics we rely on:
  - A repeated singular field: last wins.
  - A repeated embedded message (singular field): merged.
  - A repeated field: appended.
  - Separately, the client upserts content blocks and messages **by id** (last copy wins).

## Rewriting what the page receives

Hook `window.fetch` in MAIN, wrap the `StreamTimeline` body (frame by frame) and the
`ReadConversationHistory` body (unary), and splice in extra or modified data.

- **New content blocks** render, markdown included. A block reusing an existing id **replaces** it.
- **Phantom messages:** fake `Message` + `DisplayGroup` (`GROUP_STYLE_INLINE`) + `ContentBlock` render as real rows ("Message 1 of N"), each with its own toolbar.
  - **Negative indices** (`-2`, `-1`) work, so real messages keep their indices. Only the real root needs re-parenting (`parent_message_id` = the last phantom).
  - They survive live turns (send, stream, settle) and post-turn updates.
- **Re-patch every snapshot.** The stream closes every ~5 s and reopens, and a reopened stream can start with a fresh `replace_all_state` snapshot that wipes anything not in it. An `inject()`ed block vanished at the 5 s reconnect (2026-10-09). Every patch (phantoms, arrows, full load, gallery) has to apply to *every* snapshot, not just the first; the phantom experiments did that, which is why they seemed to survive reconnects.
- **Long chats:** the snapshot only holds the latest window (e.g. 30–122 messages). The root arrives in a `ReadConversationHistory` page (`ReadConversationHistoryResponse.update`), and the same splice works there.
- **Client cache:** IndexedDB `claude-conversation-store` (`trees` + `meta`, keyed by conversation uuid) holds a legacy-shaped transcript (`hub_transcript` v2: `sender`, `parent_message_uuid`, typed content, `nOptions`, `siblingUuids`).
  - It paints first on a cold load, and the stream replaces it ~100 ms later.
  - It is written from client state, so injected content persists into it. Only the snapshot window is cached.
  - **Delete those entries after any test run.**
- **Timing:** `StreamTimeline` opens ~40–500 ms after navigation, so a `document_start` MAIN hook catches it in Chrome. Firefox is untested.

## Rewriting what the page sends

Append `encodeBard(partial SendMessage)` as field 2 of the `PerformActionRequest`, so it merges into
`send_message`. Bodies may be gzip; send them plain and drop `content-encoding`. Nothing validates
the body (`origin_nonce` is not a body checksum).

| `send_message` field | Result |
| --- | --- |
| `text` (3) | Override accepted; the UI shows the server's version. |
| `hidden_context` (23, repeated string) | Reaches the model as a `<system-reminder>` on that turn and **stays in context in later turns**. **Invisible** in the UI, the legacy tree and `ReadConversation`. **Survives the native fork.** Candidate for phantom history and per-chat instructions; we keep our own copy (export can't recover it). |
| `inline_attachments` (15) | Injected text files are in context and shown on the message. |
| `attachments` (4) | Re-attaching an existing file id works (same chat; across chats untested). **New binary files** work: upload with legacy `POST /api/<org>/upload` (FormData `file` + `client_upload_id`, returns `file_uuid` and `file_kind`), then reference `{ id, file_name, file_size, media_type }`. Tested with a PNG (`image`) and a 1-page PDF (`document`, 1,570 tokens/page). |
| `parent_message_id` (5) | Any existing message works: the server branches there and **the UI follows**. `""` = new root (what a normal edit of the first message sends). An unknown id gets `stale_parent`, and the UI shows "Failed to send / Retry / Discard". |
| `model` (7) | Override works on an existing chat and sticks; the picker updates. |
| `client_tools` (16) | **The model calls tools we declare.** The stream shows a RUNNING block with `display_content.client_tool { tool_name, input_json, tool_use_id, origin_session_id, origin_version }` and the turn waits. We answer with `submit_client_tool_result (11) { tool_use_id, result_json }`, and the model uses the result. Browser-side tools for the model. |

- A normal send carries **no** `parent_message_id` (the server continues its own leaf). The client *does* set it when sending from a branch that `set_current_leaf` just moved to.
- Untested: `settings_update`, `answer_now`, `work_mode_override`, `chat_memory_mode`, `safety_controls`, `project_id`/`is_temporary`, Retry with an arbitrary parent, cross-chat attachment ids. Deliberately not probed: `eval_params_json` (looks internal).

## Native fork

`PerformAction` `continue_branch_as_new_chat (37) { source_conversation_id, through_message_id }`,
with the header `conversation_id` = **a new uuid we choose**.

- It works through **any** message, including hidden post-cutover branches.
- **The model has the forked history in real context**, and `hidden_context` comes along.
- **Copied:** messages with new ids (UUID v5-looking), original `created_at`, attachments (new file ids, content intact), the title and all conversation settings.
- **Not copied:** the model (falls back to the default). There's no visible link back to the source.
- It **only replaces summaryless forking**. Summary forks still need their own path.
- **Not used (D8).** Further findings (2026-10-09): the request returns in ~0.4 s and the copy fills in over the next seconds (an early read saw 12 of 18 messages); it keeps the source title (`rename_conversation { title }` renames); `set_conversation_model { model { identifier } }` sets the model; **upgraded chats reject it** (400 `failed_precondition`, "This version can't be continued in a new session").

## Branches and navigation

- **Both read paths keep the full tree:** `ReadConversation` equals the legacy GET (261 messages and 33 forks; 1,403 and 315).
- **`Message.siblings_viewable` (25) gates the UI**, per fork group. It's true only for forks created before the account's cutover (here ~2026-10-07 01:35 UTC).
  - Viewable forks show "N / M" with Previous/Next version in the toolbar (hover-revealed on older rows).
  - Newer forks exist in the data but are hidden.
  - **Splicing `siblings_viewable = true` onto every message brings the arrows back.**
- **Switching versions is client-only** (no request). Viewing an older branch shows a banner: "You're viewing an earlier version · Continue in a new session · Back to latest version".
  - The composer accepts text, but **Send is disabled**. Force-enabling the button does nothing; the handlers check the state themselves.
  - Stable hooks: `[data-testid="hub-earlier-version-continue"]` and `[data-testid="hub-earlier-version-back"]`, inside `[data-cds="Banner"]` in a `cdsDockCard` above the composer. Send is `[data-testid="chat-input-send"]`.
- **Setting the leaf** (it must be a true leaf, with no children):
  - `PerformAction` `set_current_leaf (23)` works. A message with children gets `invalid_leaf_target` (on the stream only).
  - **The open page follows live:** the banner goes, Send enables, and the view stays. The next send continues that branch, with the client setting `parent_message_id` itself.
  - The legacy `PUT …/current_leaf_message_uuid` also sets the merged leaf (a message with children gets 400 "Current leaf message has unexpected children"). Not to be used, per D1.
- **Upgraded (workspace) chats can't switch in place at all.** Server-gated, tested 2026-10-09 on chat `0a8b7ec1…`:
  - `set_current_leaf` to a true leaf is accepted and acked with no error, but the leaf doesn't move. The legacy PUT returns 200 echoing the id, and the leaf doesn't move either.
  - A send whose parent isn't the current leaf is rejected on the stream with `ccrproxy_branch_send_unsupported`, "Editing and retrying aren't available here yet". No message is created.
    - Exception: `parent_message_id: ""` (a new root) was accepted after the upgrade.
  - **The sandbox (`/mnt/user-data`) is shared across branches:** a sibling branch listed the other branch's file. Nothing rolls back.
- **Which version the client shows after a flip:** the newest child at each step down (verified 2026-10-09: a fork at message 3 of `7c25d951…` showed the highest-index of 4 replies).
- **Implemented (feat/navigation):**
  - **Arrows:** `content/main/branch-arrows.js` sets `siblings_viewable` on every message of snapshots, history pages and live updates. Always on. Works in upgraded chats too (except, apparently, first-message forks).
  - **D7 banner** (`navigation.js`): when claude.ai's earlier-version banner appears (hook: `[data-testid="hub-earlier-version-back"]`; upgraded chats have no "Continue in a new session" button, so not `…-continue`), ours goes above it inside the dock card.
    - **Non-upgraded chats:** "Continue anyway" scrolls to the bottom, takes the last row's message (the viewed leaf; newest child down if it has children), sets it as the current leaf (legacy PUT) and reloads.
    - **Upgraded chats** (`workspace_upgraded` on the legacy tree): an explanation only.
  - **Jumps** (`jumpToMessage` in `message-ui.js`; bookmarks, chat search, latest/longest): always move the leaf (legacy PUT) and reload, then reveal the target after the load. No scroll-only shortcut for on-branch targets: the arrows switch versions client-side, so the server's branch isn't necessarily the one on screen.
  - **Leaf setting stays on the legacy PUT:** it sets the merged leaf, fails synchronously, and works from ISOLATED on every browser (RPCs check `Origin`). `set_current_leaf` is the contingency.
  - **Reveals right after a load:** the list pins its tail until the user scrolls, undoing any scroll of ours; a synthetic wheel event on the scroller releases it. Freshly mounted rows also get re-measured over a few frames, so the settle re-checks and scrolls again if the target drifted.
- **Why it's hidden:** the shared, non-rolling-back sandbox above. Non-upgraded chats still allow branching anywhere (edits and retries rely on it).

## Message identity in the DOM

**Implemented (PR C), in `content/helpers/message-ui.js`:**
- `turnRowOf(el)`, `uuidForTurnKey(key, tree)`, `turnKeyResolver(tree)`, `rowForUuid(uuid, tree)`;
- `messageUuidOfElement(el)` for click handlers;
- `resolveUserMessageUuid(userEl)`;
- `revealMessageByUuid` on turn keys; it reveals user and assistant messages directly.

`tree` is the whole conversation (`chat_messages`), not a branch. The injected `====UUID:…====` markers and `data-message-uuid` are gone.

- **Every row has `[data-turn-key]`**, rendered by the page, readable from ISOLATED, and updated in place on version switches.
  - **User rows:** the message's own id.
  - **Assistant rows:** their own id, except the **original reply to a merged-era send**, which is keyed `<parent user id>-hub-reply`. Retries and pre-merge replies use their own id, so every version of a reply has a distinct key.
  - **`-hub-reply` resolves to the lowest-index assistant child of that user message** (`createdAt` as the tiebreak). Verified against React's displayed id on 72 rows across 5 chats (35 hub rows), zero mismatches, including an original-plus-retry case. `inputMode` is never populated on read, so "the non-retry child" can't be used.
- **Row DOM:**
  - User text is `[data-testid="user-message"]`, assistant text `[data-testid="assistant-message"]` (`.font-claude-response` is gone; fixed on main in `e0f13ea`).
  - Toolbars: `[role="toolbar"][data-cds="MessageActions"]` when rendered (always on the last reply, otherwise on hover), or a collapsed `[data-testid="message-actions"]`.
- A row can be a **chain** of several messages (`isChain`); none seen yet, maybe tool-call related. Leaf-type operations should use the last message.
- **Debug only:** React props, walking `__reactFiber$…` `.return` from the turn-key element to the props holding `item.chain`, give `chain.displayUuid`, `messageUuids`, `lastMessageUuid` and a transcript-shaped `lastMessage` (`selectedOption`, `nOptions`, `siblingUuids`). Useful for cross-checks; not for production (D5).

## Loading every message (and Ctrl+F)

**Implemented: `content/main/full-load.js`**, an `onSnapshot` patch on the host.
- **Rewrites each snapshot that has `older_history_cursor` in place** (revised 2026-10-09, the first version injected a second snapshot): minus 29/30, plus the full tree. The first snapshot waits for the fetch (the host keeps frames in order, so later updates queue behind it). Reconnect snapshots are filled from the cache at once.
- **Why in place:** an injected snapshot made the page forget a version picked with the branch arrows on every reconnect (a flipped old fork went back to latest at the next `StreamTimeline` connection). Native reconnect snapshots and in-place ones keep the pick. In-place also removes the race with updates arriving during the fetch.
- **Cost:** on a cold page cache the first rows appear with the whole list, at ~2.9 s instead of the window at ~1.9 s (1,403-message chat); with the page cache warm, 258 rows at ~1.3 s.
- **Full tree:** `ReadConversation` through `QolBardHost.rawFetch`, cached per conversation for 5 minutes. Each reconnect snapshot reuses the cache, with its own entries winning.
- **Toggle:** "Load whole conversations" in the gear modal (`extension-settings.js`), default on, mirrored to `localStorage.claude_qol_full_load` (`'0'` = off). It applies on the next load, and Save reloads.
- **Verified 2026-10-09:**
  - Chrome:
    - 16 → 258 rows by 2.4 s;
    - Ctrl+F finds message 1 (1/1, previously 0/0);
    - still 258 after 6 stream connections over 3 minutes, from one `ReadConversation`, with no history calls;
    - toggle off gives native paging again;
    - a short chat makes no call.
  - The desktop client: 16 → 258.

- **How the list grows:** from the snapshot's window, bounded by `older_history_cursor` (29) and `baseline_floor_message_id` (30), and **only** through `ReadConversationHistory` pages. Older messages in an ordinary update are ignored.
- **Original approach (superseded, see above):** pass the real snapshot through, fetch `ReadConversation` (proto, response field 2 = the update), then enqueue a **synthetic second snapshot**: the original snapshot's fields (keeping `replace_all_state`) minus 29/30, plus the full tree's messages/display groups/content blocks (3/4/5).
  - 1,403-message chat (2.4 MB, ~1 s fetch): all 258 current-path rows known ~1.5 s after load, no scroll jump, jump-to-top instant, zero history calls.
  - The blocking alternative (merge into the real snapshot) also works but delays the snapshot by the fetch (672 ms for 772 KB).
- **Re-apply on every later `replace_all_state`.** A patched tab fell back from "of 258" to "of 16" within minutes once a fresh snapshot arrived.
- **Ctrl+F is claude.ai's own find bar** (input labelled "Find"). It searches every **loaded** message, mounted or not, and fails today only because older messages aren't loaded. Full load restores it for the current branch; QoL chat search covers other branches.
- **Plumbing:** settings are ISOLATED-only and load at `document_idle`, after the first snapshot. Mirror the toggle into a page `localStorage` key (e.g. `claude_qol_full_load`) that MAIN reads synchronously at `document_start`.
- While the toggle is on, the stream stays wrapped for the whole session, so the toggle is also the off switch for any jank.
- The page caches the full tree in IndexedDB; clear it after tests.
- Acceptance check: Ctrl+F finds a word from message 1 of a long chat, both right after load and minutes later.

## Toolkit (common)

All in common's versioned `net.js` + `bard-schema.js`. **Built:** claude-ext-common #23 (`cc476c8`, net.js VERSION 4), pinned on this branch in `988e9bd`. Besides what's listed below, it also has `readProtoRequestBody` / `withProtoRequestBody` / `protoResponse`.

Precedence rules:
- `encodeBard` writes `$unknown` *before* the known fields, so an explicitly set field beats retained data in the same oneof.
- `rewriteConnectStream` delivers frames `inject()` already accepted even if the source ends at that moment, and a throwing `onError` can't break fail-open.

- **`decodeBard(type, bytes, { keepUnknown: true })`.** Every decoded message object carries `$unknown`, the raw records the schema didn't recognise. It's a plain property, so it survives `postMessage`/`structuredClone`.
- **`encodeBard(type, obj)`.** The mirror of `decodeBard`'s JSON shape, writing `$unknown` back. It also builds new messages from scratch.
- **Rule of thumb, chosen by blast radius, not speed:**
  - **Append** `encodeBard(partial)` onto the original bytes for pure additions (phantoms, blocks, `hidden_context`, `client_tools`, new attachments, hiding via `deleted_*_ids`) and for singular-field overrides (`parent_message_id: ""`, `model`).
  - **Round trip** (decode, edit, encode) only to edit or remove *inside an element of a repeated field*: messages in an update (re-parenting the root, `siblings_viewable`), or removing request attachments.
- **Field references by name** through the schema, so a field that disappears after a regeneration fails loudly.
- **Frame helpers:**
  - A frame writer next to `readConnectFrames`.
  - A stream rewrite wrapper that passes untouched frames (heartbeats, deltas) through as the original bytes and decodes only message-bearing frames.
  - Unary body helpers (gunzip, header fix-up).
- **Cost:** decoding the full 1,403-message tree takes 12.9 ms. Patching fires on snapshots, history pages, message-bearing live updates and sends; never on heartbeats.
- **Jank caveat:** any body rewrite re-pipes every chunk through our `ReadableStream`, and the old completion-stream jank was never bisected. Test on the affected machines.
- **Proof (extend `check-decoder.mjs`):**
  - **Round trip:** decode with unknowns kept, re-encode, and require protobuf-es equality, unknown fields included.
  - **Drift:** decode with a deliberately trimmed schema and check that the missing fields survive.
  - **Well-known types to watch:** Timestamp nanos, Duration, Struct/Value, FieldMask casing, NaN/Infinity floats.

## Interceptor host (`content/main/bard-host.js`)

The one place QoL intercepts the RPCs. **Features never wrap them themselves**; they register patches with `QolBardHost`:

| Registration | Runs on |
| --- | --- |
| `onSnapshot(fn)` | every `StreamTimeline` update with `replace_all_state`: the first one, reconnect snapshots, and snapshots injected through `ctx.inject` |
| `onLiveUpdate(fn)` | other `StreamTimeline` updates carrying messages / display groups / content blocks |
| `onHistoryPage(fn)` | `ReadConversationHistoryResponse.update` |
| `onSend(fn)` | `PerformAction`'s `send_message`, before it leaves |
| `observe(fn)` | read-only, every non-heartbeat `StreamTimeline` event as the server sent it |

- **A patch** is `fn(target, ctx)`. It may be async, edits `target` in place (decoded with `keepUnknown`), and returns `true` if it changed something. The host re-encodes only then; otherwise the original bytes pass through.
- **`ctx`:** `{ source, orgId, conversationId, inject }`.
- **`ctx.inject(event)`** (streams) runs injected snapshots through the `onSnapshot` patches first, which is the composition guarantee full load needs. It returns `false` once that connection has ended (the server reconnects on a cadence), so inject from the current connection's `ctx`.
- **Registration order is execution order.** An optional `{ label }` names a patch in logs.
- **Fail-open:**
  - a throwing patch is logged and skipped;
  - an undecodable frame or body passes through as it came;
  - a method with nothing registered isn't wrapped at all.
- **Escape hatches:**
  - `QolBardHost.rawFetch` (MAIN-world calls that must see server data; ISOLATED fetches are never patched);
  - kill switch `localStorage.claude_qol_bard_host_off = '1'`.
- **Manifest position:** first in the MAIN group after `extra-models.js`, preceded only by `net.js` and `bard-schema.js` (Firefox ordering). The logger and `page.js` are looked up lazily.
- **Feature scripts that register patches load right after the host** (e.g. `full-load.js`). The host decides at fetch time whether to wrap a connection, so a feature registering after the page's first `StreamTimeline` would miss that snapshot (Firefox). Like the host, they look up later globals lazily.
- **Account mode:** `QolBardHost.accountMode()` in MAIN, or `qolAccountMode()` (toolbox-ui.js) in either world, gives `'merged' | 'legacy' | 'unknown'` for the active org, from page `localStorage.claude_qol_account_mode`.
  - **`merged`:** any successful RPC response sets it.
  - **`legacy`:** only an hourly `GetNewConversationDefaults` probe returning 403 `permission_denied` sets it.
  - With `legacy`, `notifications.js` shows a once-per-session card.
- **Verified live (2026-10-09):**
  - patches survive reconnect snapshots;
  - an injected clean snapshot went through `onSnapshot`;
  - `onSend` `hidden_context` reached the model;
  - `onHistoryPage` fired on every page;
  - a throwing patch was harmless;
  - the kill switch disables wrapping;
  - the legacy card shows.
- **Firefox (Android Nightly, verified 2026-10-09):**
  - `QolBardHost.diagnostics` (`{ loadedAt, firstSeen: { [method]: ms } }`, performance clock) showed the host in place ~300 ms before the page's first `StreamTimeline` on every one of 5 loads (e.g. 851 → 1154 ms);
  - an `onSnapshot` patch rendered.
  - Check `diagnostics` again if Firefox ever seems to miss the first snapshot.

## Legacy accounts (for D3)

- **How to recognise one:** RPC endpoints return 403 "This feature is not included in your current plan". Tabs say "New chat" (merged: "New session").
- **Frontend:** the same shell ("Message N of M" rows, `message-actions`, `chat-input-send`, the IndexedDB cache), but it loads through the legacy tree GET and `/completion`.
  - Rows come from a different component with **no `data-turn-key` and no ids** in the DOM.
- Calling `/completion` directly still works on merged chats, but ignores the merged chat's model (it replied with Opus 5.5 on a Haiku chat). Irrelevant under D1, but useful to know.

## Feature map (starting point for the drill-down)

Every "splice" / "rewrite" / "watch the stream" below means a patch registered with the [interceptor host](#interceptor-host-contentmainbard-hostjs): `onSnapshot` / `onHistoryPage` / `onLiveUpdate` / `onSend` / `observe`.

| Feature | Merged approach | Notes |
| --- | --- | --- |
| Phantom messages | Splice into snapshot and history pages; rewrite phantom `parent_message_id` to `""` on root edits | **Implemented** (feat/phantoms), see [Phantom messages](#phantom-messages-implemented). | Retry and non-root edits need nothing. |
| Forking, summaryless | QoL's own fork (D8) | Unchanged: works on merged accounts (verified 2026-10-09), phantoms display. Upgraded chats: warning in the dialog. |
| Forking, summary / compaction | QoL's own fork (D8) | Unchanged: summaries through `/completion` in a throwaway chat, now on Haiku 5.5 (`FAST_MODEL`), verified end to end 2026-10-09. Porting `/completion` sends to `PerformAction` is a separate, later item (also TTS dialogue analysis and import). |
| Advanced edit (files) | Rewrite the edit's `send_message`: add or remove `attachments` / `inline_attachments` | Removal is a round trip. |
| Navigation / bookmarks / chat search jumps | Full load + `data-turn-key` identity + legacy leaf PUT | Implemented (feat/navigation). Upgraded chats, other-branch targets: to be implemented. |
| Branch arrows | Splice `siblings_viewable` on snapshots, history pages and live updates | Implemented, plus the D7 banner. |
| Image gallery | Splice blocks into stream and history pages (live and on load) | |
| TTS auto-speak | Watch `StreamTimeline` for the settle (status leaves busy for idle) | The tracker's `request-hook.js` already does this. |
| TTS "Read aloud" hijack | Unchanged (WebSocket) | Retest. |
| Export / chat search data | Legacy tree GET, unchanged (D1 revised) | Contingency if it fails: `ReadConversation` (full tree, JSON or proto) through an adapter. Text attachments are file URLs there (fetch the content), and tool input is summarised. |
| Project file download | Project data is still legacy REST; buttons must move into the "Context" dialog (table behind "Show context") | |
| Model extras | `model` override on `send_message`; check the bootstrap/model-selector patching separately | |
| Browser-side tools (new) | `client_tools` + `submit_client_tool_result` | New capability; nothing uses it yet. |

## UI survey (main @ `e0f13ea`)

- **Chat:** all header buttons and user-message buttons work. Fork and bookmark were fixed in `e0f13ea`.
- **Home (`/new`):** fine (`#dframe-header-actions-slot`).
- **Project page:** buttons now anchor in the header (fixed in `e0f13ea`). Files moved into the Context dialog; QoL's download buttons are not there yet.
- **Projects list:** no QoL UI (probably none intended).
- **Not surveyed:** Code/Cowork pages, the artifacts page, mobile layout, Electron, sidebar features, and whether each modal still opens and works.

## Phantom messages (implemented)

`content/main/phantom-messages.js`, on the host, right after `full-load.js`:
- **Snapshots:** the phantoms (legacy history JSON from `ClaudePhantomMessagesDB`) become `Message`s with indexes -n..-1, each with display groups and content blocks; the real roots get `parent_message_id` = the last phantom. A chain ending on a user message gets the "Acknowledged - end of previous conversation." reply (id `<last>-qol-ack`).
- **Live updates and history pages:** only the re-parenting (a root arriving later; editing the first real message makes a new root).
- **Sends:** a phantom `parent_message_id` (in practice the last phantom) becomes `""` (a new root). Verified: the edit is accepted, the new root comes back in a live update, is re-parented, and the reply streams under the phantoms.
- **What carries through an injected snapshot** (hand-rolled experiment, 2026-10-09): user text (rendered like real user text), assistant markdown, `Message.attachments` (a text file with only a name renders as a card; an image with an org file `url`/`thumbnail_url` renders), `TIMELINE` thinking groups (full text on expand), `TIMELINE` tool rows (name, input, result image). Mapping used: text → inline markdown; `tool_use` + `tool_result` → a timeline tool row; `files_v2` and text `attachments` → `Message.attachments`; **thinking dropped** (claude.ai doesn't show it any more).
- **Page ids:** phantoms keep their source chat's uuids, which would collide with that chat's real messages (dimmed rows and rewritten sends there after navigating from a fork). So on the page they get ids of their own: `claude-api.js`'s `phantomMessageId` (`fffffffe-` + the rest of the uuid; stable, UUID-shaped, a prefix no real id has). `isPhantomId` recognises a phantom by id or turn key; `getRenderedMessages` uses the same ids.
- **DOM:** rows whose `data-turn-key` is a phantom id are dimmed and their toolbar hidden. No text markers any more.
- **Timing:** the phantoms live in ISOLATED (encrypted), so `databases.js` mirrors the ids of conversations that have them to `localStorage.claude_qol_phantom_ids`; only those snapshots wait (up to 6 s). MAIN's bridge calls are answered from `document_start` by `content/isolated/db-serve.js` (handlers await `databases.js`), so an early call isn't lost any more.
- **Rebuild:** with nothing stored, a root whose `Message.attachments` include `chatlog.txt` (a QoL fork) has its phantoms rebuilt from it (and `summary_chunk_N.txt`), stored, and shown in that same snapshot. Verified on a fresh fork.

## Still open

- **To be implemented: jumps to another branch in upgraded chats.** Their leaf can't move, so a bookmark or search result on another branch can't be reached by moving it (today the PUT is a silent no-op and the reveal finds nothing). Idea: drive the version arrows programmatically to show that branch.

- Firefox (MAIN-world ordering) and Electron, for every interceptor.
- Cross-chat attachment ids; the untested `send_message` fields listed above.
- What a multi-message row chain (`isChain`) is.
- The stream wrapper's jank behaviour on the affected machines.

## Test artefacts

- **Chats on the test account** (all deletable):
  - Native fork of the splice test chat: `20181d23…`; QoL summary fork of it: `8de34a8a…`
  - QoL fork of the splice test chat (phantoms, chatlog.txt): `88219972…`
  - "Splice test chat" `d22a3a67…`
  - UI fork of 4c18a389: `8d5de03a…`
  - Hand forks: `12274be5…`, `7e601b34…`
  - Upgraded-chat branch test: `0a8b7ec1…` (has a sandbox with `a.txt` / `b.txt`)
- **After any experiment** that rewrites the stream, delete that conversation's entries from IndexedDB `claude-conversation-store` (`trees` and `meta`).
