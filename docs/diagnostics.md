# Diagnosing a voice session

Run the backend and frontend with separate terminals, then keep their output from the same call. Backend operational lines are JSON on stderr. `timestamp`, `component`, and `event` identify the stage; `sessionId` links session and transcript lines to a `voice_sessions` row, while reconciliation lines also carry `jobId` and the ordinal range. These lines contain codes and IDs, not transcript text, memory content, SDP, audio, or API keys. The frontend proxy reports `upstream_failed` only when its fetch to port 3001 rejects.

For a new call, follow `session.started` → `session.sideband_connecting` → `session.active` → `session.capture_ended`. A `transcript.normalization_failed` line identifies a rejected provider event by type and event ID. A `transcript.integrity_failed` line adds `detailCode`, such as `predecessor_conflict` or `unsupported_response_item`. The latter is the useful starting point for an incomplete capture. `session.sideband_event_failed` and `capture_ended` show how that failure propagated. An integrity failure permanently fences the current capture; start a new call after fixing its cause.

Reconciliation is separate. `reconciliation.attempt_failed` includes `state=retry_wait` and `nextAttemptAt` when another extraction attempt will run. `state=blocked` requires an operator decision. `reconciliation.applied` means a later attempt succeeded. A successful job can retain `last_error_code` from an earlier attempt, so inspect `state`, `attempts`, and `finished_at` together. `duplicate_source` means one model proposal repeated the same transcript source within that proposal; it does not by itself indicate a broken Realtime connection.

For a session ID shown in the Voice screen or log, inspect durable state without displaying private transcript text:

```sql
SELECT id, state, close_reason, error_code, ordered_through, sealed_through,
       applied_through, last_client_heartbeat_at, last_sideband_event_at
FROM voice_sessions WHERE id = 'SESSION_UUID';

SELECT ordinal, role, state, expected_parts, error_code, first_seen_at, terminal_at
FROM transcript_items WHERE session_id = 'SESSION_UUID'
ORDER BY ordinal NULLS LAST, first_seen_at;

SELECT id, from_ordinal, through_ordinal, state, attempts,
       last_error_code, available_at, finished_at
FROM reconciliation_jobs WHERE session_id = 'SESSION_UUID'
ORDER BY from_ordinal;
```

When the browser says it cannot reach the backend, check both the direct backend and frontend proxy:

```sh
curl -i http://127.0.0.1:3001/health/ready
curl -i http://127.0.0.1:3000/api/sessions/SESSION_UUID
```

`backend_unreachable` means the browser request itself rejected; `proxy_unreachable` means the frontend server could not connect to the backend; `service_unavailable` means the backend or another server returned a 5xx response; `invalid_server_response` means the browser could not parse the response. If `/health/ready` returns 200 but the session is `incomplete`, inspect the session and transcript logs rather than treating it as a network outage. Restart the backend process after changing backend code to see the new log fields.
