# Layer 3 implementation plan: Realtime session initialization and transport

Status: implemented; automated acceptance complete, manual Realtime smoke pending
Architecture source: [Openloop MVP architecture](../docs/mvp-architecture.md), section 5
Prerequisites: [layer 1](layer-1-implementation.md) and [layer 2](layer-2-implementation.md)
Scope: browser WebRTC setup, backend-created Realtime calls, sideband ingestion, and session lifecycle only

## 1. Outcome and boundary

Layer 3 connects the browser to OpenAI Realtime over WebRTC and connects the backend to that exact call over a sideband WebSocket. The backend creates the call, saves the provider call ID returned in the `Location` header, and is the only component allowed to attach the sideband or write transcript events. The browser microphone stays disabled until the peer connection, data channel, sideband, database ingestion path, and effective Realtime transcription configuration are all ready.

This layer is complete when a real two-turn voice conversation produces durable final user transcripts in verified conversation order and creates the expected pending reconciliation jobs. It does not run the text extractor, read Mind into the conversation, schedule commitments, execute tools, accept transcript text from the browser, or persist partial transcript deltas or audio.

The implementation remains on the Realtime API under `/v1/realtime/*`. Do not mix in GPT-Live `/v1/live/*` sessions or their event names. OpenAI's [server-side controls guide](https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime&voice-api=realtime) documents that the WebRTC call response supplies a `Location` call ID and that a server can attach to the same call at `wss://api.openai.com/v1/realtime?call_id=...`. The [Realtime event reference](https://developers.openai.com/api/reference/resources/realtime/server-events) documents that `session.updated` contains the full effective configuration, while final input transcription events are asynchronous. These provider facts do not weaken layer 2's ordering and completeness rules.

## 2. Reuse, deliverables, and dependencies

Reuse the existing `voice_sessions` table, user-first lock order, `TranscriptIngestor`, `SerialTranscriptProcessor`, HTTP error envelope, and demo-user request scope. No schema migration is required. `call_id`, `realtime_session_id`, state timestamps, heartbeat, epoch, and error fields already represent the required durable state. Sideband readiness and cached SDP answers are intentionally process-local: after a restart, layer 2 marks unfinished sessions incomplete instead of pretending the transport can be resumed without loss.

Expected backend files:

```text
apps/backend/src/contracts/session-transport.ts
apps/backend/src/sessions/repository.ts
apps/backend/src/sessions/openai-gateway.ts
apps/backend/src/sessions/sideband.ts
apps/backend/src/sessions/controller.ts
apps/backend/src/sessions/supervisor.ts
apps/backend/src/sessions/routes.ts
apps/backend/src/sessions/index.ts
apps/backend/tests/sessions/*.test.ts
```

Expected browser files, added within the smallest existing or new React frontend shell:

```text
apps/frontend/src/voice/session-client.ts
apps/frontend/src/voice/use-voice-session.ts
apps/frontend/src/voice/VoiceConversation.tsx
apps/frontend/tests/voice/session-client.test.ts
```

Add `ws` and `@types/ws` to the backend for an authenticated server-side WebSocket with custom headers. Add only `react`, `react-dom`, and their type packages if the Openloop frontend does not yet exist. Use Bun's existing build and test capabilities; do not add Axios, a WebRTC wrapper, a state library, a browser transcript service, a queue service, or a test-only HTTP mocking framework. Test the browser state machine through injected browser adapters so a DOM emulator is unnecessary.

## 3. Public contracts

Add strict Zod schemas and inferred TypeScript types. Provider identifiers are bounded opaque strings and must never be parsed as UUIDs or sequence numbers. SDP is sensitive transient transport data: validate it, hash it, keep the answer in a bounded in-memory cache, and never log or persist either offer or answer.

```ts
type StartSessionRequest = Readonly<{
  startRequestId: UUID;
  sdpOffer: string;
  timezone: string;
}>;

type StartSessionResponse = Readonly<{
  sessionId: UUID;
  sdpAnswer: string;
  state: "connecting";
}>;

type SessionStatus = Readonly<{
  sessionId: UUID;
  state: VoiceSessionState;
  captureReady: boolean;
  orderedThrough: number;
  sealedThrough: number;
  appliedThrough: number;
  reconciliationBacklog: number;
  closeReason: string | null;
  errorCode: string | null;
}>;

interface RealtimeGateway {
  createCall(input: CreateCallInput, signal: AbortSignal): Promise<{
    callId: string;
    sdpAnswer: string;
  }>;
  connectSideband(callId: string, handlers: SidebandHandlers): SidebandConnection;
  hangup(callId: string, signal: AbortSignal): Promise<void>;
}

interface SidebandConnection {
  send(payload: unknown): void;
  close(): void;
  readonly closed: Promise<void>;
}

interface SessionController {
  start(scope: UserScope, request: StartSessionRequest): Promise<StartSessionResponse>;
  status(scope: UserScope, sessionId: UUID): Promise<SessionStatus>;
  activate(scope: UserScope, sessionId: UUID): Promise<SessionStatus>;
  heartbeat(scope: UserScope, sessionId: UUID): Promise<SessionStatus>;
  close(scope: UserScope, sessionId: UUID): Promise<SessionStatus>;
}
```

`StartSessionRequest` is a strict object. `startRequestId` is generated once per browser peer connection. `sdpOffer` must be non-empty, contain no NUL byte, and be at most 65,536 UTF-8 bytes. `timezone` uses the existing IANA validator. Route parameters remain user-scoped UUIDs. Unknown fields and query parameters are rejected.

Extend typed domain errors with `active_session_exists`, `start_request_conflict`, `restart_required`, `session_not_ready`, `upstream_failure`, and `setup_timeout`. Map the first four to HTTP 409, upstream failure to 502, and setup timeout to 504. Continue mapping validation to 400 and ownership-safe absence to 404. Responses never contain the OpenAI API key, provider call/session IDs, raw provider errors, SDP hashes, transcript bodies, or raw events.

## 4. Fixed Realtime configuration

Build the session configuration in one pure function shared by call creation and sideband readiness checks. Its runtime values come from validated backend configuration:

- `OPENAI_API_KEY`, server-only and required outside tests.
- `OPENAI_REALTIME_MODEL`, required; `.env.example` may show a currently supported Realtime model.
- `OPENAI_TRANSCRIPTION_MODEL`, required; `.env.example` may show a currently supported input-transcription model.
- `OPENAI_REALTIME_VOICE`, default `marin`.
- `RECONCILIATION_MODEL`, `RECONCILIATION_PROMPT_VERSION`, and `RECONCILIATION_SCHEMA_VERSION`, passed unchanged into layer 2 when jobs are created and later reused by layer 4.

The Realtime session has `type: "realtime"`, audio output, the configured voice, input transcription explicitly enabled, `server_vad` with automatic response creation and interruption enabled, an empty tool list, tool choice `none`, and fixed application instructions. The instructions describe a concise ambient conversational assistant and must explicitly avoid claiming access to saved Mind data. Do not request an initial response or greeting. Pin concrete VAD values in code and tests: threshold `0.5`, prefix padding `300 ms`, and silence duration `500 ms`.

The initial multipart call request includes `sdp` and the full `session` JSON. After sideband open, send one `session.update` containing the mutable subset—application instructions, empty tools/tool choice, input transcription, and VAD. The corresponding `session.updated` event does not echo the client event ID, so readiness is established by receiving the next valid effective configuration after that update and comparing the required fields, not by inventing request correlation. A provider `error` referencing the update event or a mismatched/disabled transcription configuration fails setup.

## 5. Durable state machine

All state transitions lock `mind_state` and then `voice_sessions`. Network calls never run in a database transaction.

| From | Event | To | Required durable changes |
| --- | --- | --- | --- |
| none | valid first start | `initializing` | allocate sequence, store request ID, SHA-256 offer hash, timezone, epoch 1 |
| `initializing` | call ID saved | `connecting` | save `call_id`; never overwrite it with another known ID |
| `connecting` | activation after runtime readiness | `active` | set `activated_at`, initial heartbeat, and updated time |
| `active` | user close or 15-minute limit | `draining` | set `close_requested_at`; keep epoch unchanged so final events remain writable |
| `draining` | clean transcript drain | `closed` | layer 2 seals safe batches, sets terminal fields, and fences the epoch |
| `active`/`draining` | sideband loss, browser loss, queue failure | `incomplete` | layer 2 seals only the safe prefix, excludes known suffix, and fences the epoch |
| `initializing`/`connecting` | browser cancellation | `failed` | no audio was authorized; fence the epoch and clean up any known provider call |
| `initializing`/`connecting` | setup failure or deadline | `failed` | set terminal time and bounded setup error; increment the epoch |

Only pre-activation setup failures use `failed`; once audio could have flowed, any unexpected loss is `incomplete`. Terminal transitions are idempotent. A terminal row is never reused for another peer connection. The partial unique index remains the authority preventing two live sessions for one user.

`captureReady` is true only while the process owns an open sideband for that session, its serial processor is available, the provider session ID has been saved, and the effective `session.updated` configuration matches the fixed transcription/VAD settings. It is false after any fatal error, close initiation, socket closure, or process restart. It does not need a database column.

## 6. Start reservation and idempotency

`SessionController.start` first computes the offer hash and enters an in-process coordinator keyed by `(userId, startRequestId)`. The coordinator installs the first promise synchronously so simultaneous identical requests await one operation. A different offer hash for the same key fails with `start_request_conflict` without touching OpenAI.

The first operation uses a short transaction:

1. Lock the user's `mind_state` row.
2. Look up `(user_id, start_request_id)` before checking the live-session index.
3. If the row exists with another hash, return `start_request_conflict`.
4. If the row exists and no matching in-memory promise or cached answer remains, schedule that row for terminal cleanup and return `restart_required`; an SDP answer cannot be reconstructed from PostgreSQL.
5. Otherwise verify no different live session exists, allocate `next_session_seq`, insert `initializing`, and commit.

Call creation happens once after reservation. Cache the successful `StartSessionResponse` in memory for 30 seconds so a lost HTTP response can be replayed without creating another provider call. Return 201 for the owner request and 200 for an identical cached replay. On cache expiry, remove the SDP answer. A later repeat gets `restart_required`, finalizes any still-live old session, and requires a fresh browser peer plus request ID.

Never retry `POST /v1/realtime/calls` automatically. If it succeeds but the response is lost before the call ID is observed, the provider call may remain orphaned until provider expiry; the local row becomes failed and the browser stays muted. If the call ID is known but saving it or later setup fails, attempt hangup after the terminal database transition.

## 7. OpenAI HTTP and call-ID binding

`OpenAIRealtimeGateway.createCall` uses the server API key and a `FormData` body against exactly `https://api.openai.com/v1/realtime/calls`. Apply a 10-second abort timeout within the 15-second overall setup deadline. Do not expose a configurable production hostname; tests inject a gateway or local endpoint adapter.

Require a successful upstream status, a non-empty SDP answer of at most 65,536 UTF-8 bytes, and a valid `Location`. Resolve a relative `Location` against `https://api.openai.com`, then require the same origin and a path exactly matching `/v1/realtime/calls/{opaque-call-id}` with no extra segment. Validate and preserve the call ID unchanged. Missing, blank, malformed, cross-origin, or oversized values are upstream failures. Never accept a call ID from the browser and never stringify an absent value into `"undefined"`.

After saving the call ID, create the sideband with the encoded saved value at `wss://api.openai.com/v1/realtime?call_id=...` and `Authorization: Bearer ...`. Register open, message, error, and close handlers before the connection can report ready. Bound a single decoded text message to 1 MiB and reject binary/application audio payloads; the MVP does not store reflected audio. Sideband open plus configuration acknowledgment must occur before the overall 15-second setup deadline.

## 8. Sideband ownership and event flow

Create one runtime record per connecting/active/draining session containing the sideband, capture epoch, `SerialTranscriptProcessor`, readiness promise, fatal-finalization promise, and timers. There is no reconnect loop. A replacement socket could miss events, so any unexpected close ends capture.

The sideband dispatcher has two paths:

1. Parse `session.created`, `session.updated`, and provider `error` as bounded control events. Save the provider `session.id` once; a conflicting ID is fatal. Send the fixed update after open and resolve readiness only after its effective configuration is observed.
2. Pass every other decoded JSON object to `SerialTranscriptProcessor.push`. Its normalizer discards deltas before queue admission and its bounded serial chain awaits each database write. Attach a rejection handler to every returned promise so no WebSocket callback creates unhandled work. A relevant conversation event returning `capture_closed` before activation is a setup protocol failure; after a terminal transition it is only a late event and is ignored during socket cleanup. One fatal path owns socket close and finalization.

Do not log raw messages, SDP, transcripts, instructions, authorization headers, or provider error bodies. Structured logs may contain the Openloop session UUID, lifecycle state, bounded application error code, queue depth, and timing. Provider errors are mapped to stable codes such as `realtime_auth`, `realtime_rejected`, `sideband_open_timeout`, `sideband_protocol`, and `sideband_closed`.

The browser data channel may drive ephemeral captions and connection UI, but it never forwards transcript text to the backend. If both browser and sideband receive the same provider event, only the sideband copy enters Mind.

## 9. HTTP lifecycle

Mount the session start route with route-specific JSON parsing large enough for the encoded request, then enforce the 64 KiB SDP byte limit in the schema/service. Keep the existing smaller JSON limit for other routes.

| Endpoint | Success behavior |
| --- | --- |
| `POST /api/sessions` | Reserve and create the provider call; return 201, or 200 for an identical in-memory replay, with `StartSessionResponse`. |
| `GET /api/sessions/:id` | Return user-scoped `SessionStatus`; during setup the browser polls every 500 ms. |
| `POST /api/sessions/:id/activate` | Require state `connecting` and `captureReady`; transition to active. Repeated calls while active return the same status. |
| `POST /api/sessions/:id/heartbeat` | Update heartbeat only for active/draining sessions and return current status. Terminal sessions return their status without mutation. |
| `POST /api/sessions/:id/close` | Move active to draining and start clean finalization. A pre-activation cancellation becomes failed. Return 202 until terminal and 200 when already terminal. |

Status computes `reconciliationBacklog` with one query counting this session's jobs in `pending`, `running`, `retry_wait`, or `blocked`. A blocked job counts because it prevents the session from being fully applied. `captureReady` comes from the runtime registry, while all other fields come from PostgreSQL. GET performs no state transition and starts no worker.

Activation cannot prove browser peer state; the contract is that the browser calls it only after `RTCPeerConnection.connectionState === "connected"`, the `oai-events` channel is open, the remote SDP is installed, and backend status reports ready. The backend independently proves sideband/database readiness. Activation responds before the browser enables its audio track.

The browser uses relative, same-origin `/api` URLs. If frontend and backend use separate localhost ports during development, the frontend dev server proxies `/api` to the backend. Do not add permissive CORS middleware to solve local setup.

## 10. Browser voice client

Keep the transport state machine framework-neutral and make the React hook a thin lifecycle wrapper. Use a discriminated state union such as `idle`, `requesting_permission`, `negotiating`, `waiting_for_capture`, `active`, `draining`, `closed`, and `error`. Expose only serial `start()` and `stop()` commands; reject or coalesce overlapping calls.

Start sequence:

1. Request microphone access before any backend session exists. Permission denial or no device returns a local error and makes no API call.
2. Create the peer connection, remote audio element/stream handler, and `oai-events` data channel; register all handlers before negotiation.
3. Add the microphone track with `track.enabled = false`.
4. Create and install the local offer, generate a UUID start request ID, and call `POST /api/sessions` with the browser timezone.
5. Install the returned SDP answer. Poll status every 500 ms while also observing peer and data-channel state.
6. Once all three readiness conditions hold, call activate. Enable the microphone track only after the active response is received.
7. Send heartbeat every 5 seconds and stop audio immediately if a heartbeat response is terminal/incomplete or three consecutive requests cannot reach the backend.

Stop sequence disables the microphone first, cancels heartbeat and setup polling, posts close, and keeps the peer, data channel, remote audio, and backend sideband alive while status is draining. Poll until terminal or 12 seconds, then close local resources. A normal Stop button uses this path. Component unmount sends a best-effort `fetch(..., {keepalive:true})` close request after disabling audio, but does not claim clean completion; the heartbeat watchdog is the durable fallback.

Cleanup is idempotent and removes event listeners, clears timers, pauses and detaches remote audio, stops every local media track, closes the data channel, closes the peer, aborts outstanding fetches, and clears retained references. Never connect to Deepgram or use `MediaRecorder` for transcription.

## 11. Close, watchdogs, and process lifecycle

One supervisor tick every 2 seconds handles setup deadline, heartbeat loss, maximum duration, and close progress. It does not perform reconciliation.

- Setup exceeding 15 seconds marks an unactivated session failed, closes its runtime, and attempts provider hangup.
- Missing browser heartbeat for 15 seconds while active/draining disables further capture by finalizing `browser_lost` as incomplete, then closes/hangs up the provider call.
- At 15 minutes from activation, transition to draining with `error_code=session_limit`, allowing the browser to display the reason. Run the same clean drain as a user stop.
- During clean drain, wait for the serial queue and call layer 2 finalization repeatedly. Preserve the 1-second quiet window and 10-second deadline already implemented by `finishCapture`; never sleep inside the HTTP request.
- Once terminal, close the sideband and attempt provider hangup with a 5-second timeout. A hangup failure records/logs a bounded provider cleanup code but does not turn a clean, fully persisted transcript into incomplete.
- On unexpected sideband error/close or processor failure, run one shared fatal finalizer. Before activation, mark setup failed because the microphone was never enabled. After activation, drain accepted queue work and call `finishCapture` with the applicable incomplete reason. Then close local transport and hang up best-effort.

At startup, before listening for HTTP, identify unfinished sessions, call layer 2 `recoverOpenCaptures`, and best-effort hang up their saved call IDs. Do not reconnect sidebands. Then start the layer 2 batch scan and the session supervisor. On SIGINT/SIGTERM, stop accepting requests, finalize owned nonterminal sessions with `restart`, stop timers, close sockets, attempt known hangups, and only then close the PostgreSQL pool. Bound shutdown so a provider outage cannot keep the process alive indefinitely.

## 12. Independent implementation sequence and tests

Build in this order. Every step depends only on layers 1–2 and earlier layer 3 steps.

| Step | Implementation | Independent acceptance check |
| --- | --- | --- |
| 1 | Session transport schemas, configuration builder, and error mapping | Pure tests for strict JSON, byte limits, timezone, config equality, and safe error envelopes. |
| 2 | PostgreSQL session repository and state transitions | Real-Postgres tests for sequence allocation, one-live-session rule, request replay lookup before conflict, hash mismatch, ownership, pre-activation cancellation, activation/close idempotency, and epoch fencing. |
| 3 | Realtime HTTP gateway | Local fake upstream tests inspect multipart fields/auth, valid relative Location parsing, non-2xx, timeout, malformed/cross-origin Location, and oversized/empty SDP. No OpenAI call. |
| 4 | Sideband adapter and dispatcher | Fake socket tests prove handlers exist before open, exact saved-call URL, config acknowledgment, session-ID conflict, bounded JSON, delta bypass, serial awaited ingestion, queue failure, and single fatal cleanup. |
| 5 | Start coordinator and lifecycle controller | Concurrent tests prove one upstream create, 30-second cached replay, expired-cache restart requirement, call-save failure hangup, 15-second setup deadline, readiness gating, and no API response leakage. |
| 6 | HTTP routes and supervisor | Ephemeral local Express tests verify status codes/bodies, 500 ms polling compatibility, heartbeat timeout, 15-minute drain, clean/incomplete close, restart recovery, and backlog count. |
| 7 | Framework-neutral browser client plus thin React hook | Injected fake media/peer/channel/fetch/clock tests prove permission-before-start, disabled mic through setup, activate-before-enable, heartbeat handling, stop drain, timeout, and idempotent cleanup. |
| 8 | Backend wiring | Start recovery completes before listen; scanner/supervisor start once; graceful shutdown awaits owned work; existing Mind and transcript tests remain green. |

The automated layer 3 suite uses Docker PostgreSQL and local fakes only. It must not require `OPENAI_API_KEY`, microphone hardware, a browser, or network access. Add `test:sessions` and include it after the existing suites in `make test`. Run:

```sh
bun run db:migrate
bun test apps/backend/tests/sessions
bun test apps/frontend/tests/voice
bun run check-types
bun run lint
bun test apps/backend/tests/mind
bun test apps/backend/tests/transcripts
```

## 13. Manual Realtime acceptance gate

Automated fakes cannot prove that current provider event shapes match the adapter. Provide an explicitly invoked local smoke command or developer screen; never run it in normal tests or CI. With a developer-supplied API key:

1. Start Postgres, migrate, and start backend/frontend on localhost.
2. Grant microphone access and verify the browser track remains disabled until status is ready and activate succeeds.
3. Speak two turns with an assistant response between them, then stop normally.
4. Inspect PostgreSQL and confirm distinct Openloop session UUID, provider call ID, and provider session ID; final user text only; correct item IDs/predecessor chain/ordinals; no partial rows; and pending reconciliation range(s).
5. Repeat once while forcibly closing the sideband and verify the microphone stops after status/heartbeat detection, the session becomes incomplete, and only its safe transcript prefix is sealed.

Record the smoke date, configured model names, and pass/fail outcome in the implementation PR or handoff, without recording conversation text, API keys, SDP, or raw provider events.

## 14. Completion gate

Layer 3 is complete when the backend can prove which saved Realtime call each sideband controls; the browser cannot select that call or submit transcript text; no microphone audio flows before capture readiness and activation; every accepted sideband event is awaited through layer 2; start retries do not create duplicate calls while an answer is recoverable; setup, disconnect, heartbeat, drain, restart, and shutdown paths end in an explicit durable state; automated tests pass without OpenAI; and the manual two-turn smoke confirms current Realtime events produce correctly ordered durable transcripts. Layer 4 can then consume the already-created jobs without any dependency from this layer back to the reconciler.
