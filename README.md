## openloop

small implementation of a voice model (gpt-realtime-2.1 in my demo run) with which users can naturally and another text llm uses those transcripts to filtrate mind with memories, facts and commitments. Something similar to moonshot(yc s26) that i tried to replicate.

## mind

- postgreSQL stores raw conversation transcripts, memories, and commitments as logically separate records.
- semantic memories capture facts, relationships, and preferences that may remain useful beyond the original conversation.
- episodic memories capture events and experiences from the user's past, including what happened and any relevant time information.
- prospective memories(commitments) represent things the user intends or needs to do in the future, such as appointments, deadlines, promises, and reminders.


## mind reconcilation

- as the user speaks, OpenAI Realtime generates transcripts, which are stored in PostgreSQL. Only finalized user turns are considered for extraction. Since transcription events can arrive out of order, the backend reconstructs their original conversation order before processing them.
- a background process checks for completed turns every 2 seconds and groups them into reconciliation jobs. Another worker picks up these jobs and sends the user transcripts, relevant earlier conversation context, and existing Mind records to a separate OpenAI text model.
- the model (gpt-6-luna in demo run) identifies new facts, preferences, past events, and future commitments. It also attempts to reconcile new information with existing records. For example, if the user initially mentions a meeting on Friday but later changes it to Thursday, the reconciler should update the existing commitment rather than create another one.
- the model returns structured changes rather than writing directly to the database. The backend validates these changes against their source transcripts, resolves deadlines, and applies accepted updates atomically to Mind.
- reconciliation jobs are processed in order for each user, with retry and recovery mechanisms to prevent lost updates or newer information being overwritten by stale results. This process runs independently of the voice agent, so Mind can be updated while the conversation is still ongoing.

## commitment scheduling and notifs

- commitment scheduling runs as a separate background process, independently of the voice conversation and the reconciliation worker.
- every second, the scheduler checks PostgreSQL for open commitments whose resolved due times have arrived. Commitments without a resolved deadline are not scheduled.
- when multiple commitments become eligible, the scheduler processes them by priority (P1 before P2 before P3), followed by their due time and creation order.
- instead of immediately sending a notification, the scheduler first creates a durable log entry in PostgreSQL. Each entry is associated with a specific version of the commitment's schedule, preventing duplicate events and allowing rescheduled or canceled commitments to invalidate pending reminders.
- a separate emitter records the due event and makes it available to the frontend through a Server-Sent Events (SSE) stream. The backend also writes the event to the terminal.
- frontend receives these events and displays notification toasts. If a commitment is subsequently completed, dismissed, deleted, or rescheduled, its old notification is no longer considered active.
- the scheduler does not automatically complete commitments when their deadlines arrive. It only records that they became due; completion remains a separate action.
- for this MVP, system push notifications are not implemented.

### improvement that i intend to do but i haven't (were not a part of this mvp)

- currently there is no retrieval mechanism for mind, so the voice agent cannot really make use of mind.
- the agent cannot do any tool calls/ there aren't any tools.
- the notifs can be replaced by something else, like the intent was to capture commitments, it depends on us what we do that with it. In this mvp, i have just decided to log them.
- let the tool decide whether to trigger reconcilation or not.
- the system is not fault tolerant imo. But that remains a future upgrade

### architecture

### demo run

### local run

for a live browser walkthrough and SQL checks against transcripts, Mind changes, and due logs, follow the [manual testing guide](docs/manual-testing.md).


