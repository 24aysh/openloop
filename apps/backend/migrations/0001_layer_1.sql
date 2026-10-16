CREATE TABLE users (
  id uuid PRIMARY KEY,
  timezone text NOT NULL CONSTRAINT users_timezone_nonempty CHECK (btrim(timezone) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mind_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CONSTRAINT mind_revision_nonnegative CHECK (revision >= 0),
  next_session_seq bigint NOT NULL DEFAULT 1 CONSTRAINT mind_next_session_positive CHECK (next_session_seq >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voice_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_seq bigint NOT NULL CONSTRAINT sessions_seq_positive CHECK (session_seq >= 1),
  start_request_id uuid NOT NULL,
  offer_hash text NOT NULL CONSTRAINT sessions_offer_hash_format CHECK (offer_hash ~ '^[0-9a-f]{64}$'),
  call_id text,
  realtime_session_id text,
  state text NOT NULL CONSTRAINT sessions_state_check CHECK (state IN ('initializing','connecting','active','draining','closed','incomplete','failed')),
  timezone text NOT NULL CONSTRAINT sessions_timezone_nonempty CHECK (btrim(timezone) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  closed_at timestamptz,
  close_requested_at timestamptz,
  last_client_heartbeat_at timestamptz,
  last_sideband_event_at timestamptz,
  capture_epoch bigint NOT NULL DEFAULT 1 CONSTRAINT sessions_epoch_positive CHECK (capture_epoch >= 1),
  ordered_through integer NOT NULL DEFAULT 0,
  sealed_through integer NOT NULL DEFAULT 0,
  applied_through integer NOT NULL DEFAULT 0,
  close_reason text,
  error_code text,
  CONSTRAINT sessions_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT sessions_unique_sequence UNIQUE (user_id,session_seq),
  CONSTRAINT sessions_unique_start UNIQUE (user_id,start_request_id),
  CONSTRAINT sessions_cursors_valid CHECK (0 <= applied_through AND applied_through <= sealed_through AND sealed_through <= ordered_through),
  CONSTRAINT sessions_terminal_closed_at CHECK ((state IN ('closed','incomplete','failed')) = (closed_at IS NOT NULL)),
  CONSTRAINT sessions_activation_state CHECK (activated_at IS NULL OR state IN ('active','draining','closed','incomplete')),
  CONSTRAINT sessions_call_id_nonempty CHECK (call_id IS NULL OR btrim(call_id) <> '')
);
CREATE UNIQUE INDEX sessions_unique_call_id ON voice_sessions(call_id) WHERE call_id IS NOT NULL;
CREATE UNIQUE INDEX sessions_one_live_user ON voice_sessions(user_id) WHERE state IN ('initializing','connecting','active','draining');

CREATE TABLE transcript_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider_item_id text NOT NULL CONSTRAINT items_provider_id_nonempty CHECK (btrim(provider_item_id) <> ''),
  predecessor_known boolean NOT NULL DEFAULT false,
  previous_item_id text,
  ordinal integer,
  role text NOT NULL DEFAULT 'unknown' CONSTRAINT items_role_check CHECK (role IN ('unknown','user','assistant','other')),
  item_type text,
  state text NOT NULL DEFAULT 'pending' CONSTRAINT items_state_check CHECK (state IN ('pending','complete','failed','interrupted','excluded')),
  expected_parts integer,
  provider_response_id text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  time_anchor_at timestamptz,
  speech_started_at timestamptz,
  speech_stopped_at timestamptz,
  audio_start_ms integer,
  audio_end_ms integer,
  terminal_at timestamptz,
  error_code text,
  CONSTRAINT items_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT items_session_fk FOREIGN KEY (user_id,session_id) REFERENCES voice_sessions(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT items_unique_provider UNIQUE (session_id,provider_item_id),
  CONSTRAINT items_ordinal_positive CHECK (ordinal IS NULL OR ordinal >= 1),
  CONSTRAINT items_parts_nonnegative CHECK (expected_parts IS NULL OR expected_parts >= 0),
  CONSTRAINT items_previous_known CHECK (predecessor_known OR previous_item_id IS NULL),
  CONSTRAINT items_anchor_user CHECK (time_anchor_at IS NULL OR role = 'user'),
  CONSTRAINT items_audio_offsets_valid CHECK ((audio_start_ms IS NULL OR audio_start_ms >= 0) AND (audio_end_ms IS NULL OR audio_end_ms >= 0) AND (audio_start_ms IS NULL OR audio_end_ms IS NULL OR audio_end_ms >= audio_start_ms))
);
CREATE UNIQUE INDEX items_unique_ordinal ON transcript_items(session_id,ordinal) WHERE ordinal IS NOT NULL;
CREATE INDEX items_by_previous ON transcript_items(session_id,previous_item_id);

CREATE TABLE transcript_parts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  item_id uuid NOT NULL,
  content_index integer NOT NULL CONSTRAINT parts_index_nonnegative CHECK (content_index >= 0),
  kind text NOT NULL CONSTRAINT parts_kind_check CHECK (kind IN ('user_audio','assistant_audio','assistant_text')),
  final_text text,
  state text NOT NULL DEFAULT 'pending' CONSTRAINT parts_state_check CHECK (state IN ('pending','complete','failed','interrupted','excluded')),
  final_event_id text,
  text_hash text,
  completed_at timestamptz,
  error_code text,
  CONSTRAINT parts_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT parts_item_fk FOREIGN KEY (user_id,item_id) REFERENCES transcript_items(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT parts_unique_index UNIQUE (item_id,content_index),
  CONSTRAINT parts_hash_format CHECK (text_hash IS NULL OR text_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT parts_completion_fields CHECK (
    (state = 'complete' AND final_text IS NOT NULL AND final_event_id IS NOT NULL AND text_hash IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'pending' AND final_text IS NULL AND final_event_id IS NULL AND text_hash IS NULL AND completed_at IS NULL AND error_code IS NULL)
    OR (state = 'failed' AND error_code IS NOT NULL AND final_text IS NULL AND text_hash IS NULL AND completed_at IS NULL)
    OR state IN ('interrupted','excluded')
  )
);

CREATE TABLE reconciliation_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  from_ordinal integer NOT NULL,
  through_ordinal integer NOT NULL,
  input_hash text NOT NULL CONSTRAINT jobs_input_hash_format CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CONSTRAINT jobs_state_check CHECK (state IN ('pending','running','retry_wait','succeeded','blocked','skipped')),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT jobs_attempts_nonnegative CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  base_mind_revision bigint,
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  last_error_code text,
  resolution_note text CONSTRAINT jobs_resolution_note_length CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT jobs_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT jobs_session_fk FOREIGN KEY (user_id,session_id) REFERENCES voice_sessions(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT jobs_unique_range_start UNIQUE (session_id,from_ordinal),
  CONSTRAINT jobs_range_valid CHECK (from_ordinal >= 1 AND through_ordinal >= from_ordinal),
  CONSTRAINT jobs_claim_fields CHECK ((state = 'running') = (claim_token IS NOT NULL AND lease_until IS NOT NULL AND base_mind_revision IS NOT NULL)),
  CONSTRAINT jobs_nonrunning_fields CHECK (state = 'running' OR (claim_token IS NULL AND lease_until IS NULL AND base_mind_revision IS NULL)),
  CONSTRAINT jobs_finished_fields CHECK ((state IN ('succeeded','blocked','skipped')) = (finished_at IS NOT NULL)),
  CONSTRAINT jobs_model_nonempty CHECK (btrim(model) <> '' AND btrim(prompt_version) <> '' AND btrim(schema_version) <> '')
);
CREATE UNIQUE INDEX jobs_one_running_user ON reconciliation_jobs(user_id) WHERE state = 'running';
CREATE INDEX jobs_available ON reconciliation_jobs(state,available_at);
CREATE INDEX jobs_user_order ON reconciliation_jobs(user_id,session_id,from_ordinal);

CREATE TABLE memories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CONSTRAINT memories_kind_check CHECK (kind IN ('semantic','episodic')),
  subject text NOT NULL CONSTRAINT memories_subject_check CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200),
  predicate text NOT NULL CONSTRAINT memories_predicate_check CHECK (char_length(btrim(predicate)) BETWEEN 1 AND 200),
  content text NOT NULL CONSTRAINT memories_content_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  occurred_at timestamptz,
  time_text text CONSTRAINT memories_time_text_check CHECK (time_text IS NULL OR char_length(btrim(time_text)) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'active' CONSTRAINT memories_state_check CHECK (state IN ('active','deleted')),
  version bigint NOT NULL DEFAULT 1 CONSTRAINT memories_version_positive CHECK (version >= 1),
  manual_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memories_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT memories_semantic_time CHECK (kind <> 'semantic' OR occurred_at IS NULL)
);
CREATE INDEX memories_list ON memories(user_id,state,kind,updated_at DESC,id DESC);
CREATE INDEX memories_by_subject ON memories(user_id,subject,predicate);

CREATE TABLE commitments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL CONSTRAINT commitments_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  subject text CONSTRAINT commitments_subject_check CHECK (subject IS NULL OR char_length(btrim(subject)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CONSTRAINT commitments_status_check CHECK (status IN ('open','completed','dismissed')),
  priority smallint NOT NULL DEFAULT 2 CONSTRAINT commitments_priority_check CHECK (priority BETWEEN 1 AND 3),
  due_at timestamptz,
  due_timezone text,
  due_text text CONSTRAINT commitments_due_text_check CHECK (due_text IS NULL OR char_length(btrim(due_text)) BETWEEN 1 AND 500),
  due_precision text NOT NULL DEFAULT 'none' CONSTRAINT commitments_due_precision_check CHECK (due_precision IN ('instant','date','unresolved','none')),
  version bigint NOT NULL DEFAULT 1 CONSTRAINT commitments_version_positive CHECK (version >= 1),
  schedule_version bigint NOT NULL DEFAULT 1 CONSTRAINT commitments_schedule_version_positive CHECK (schedule_version >= 1),
  manual_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  dismissed_at timestamptz,
  CONSTRAINT commitments_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT commitments_status_timestamps CHECK (
    (status = 'open' AND completed_at IS NULL AND dismissed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND dismissed_at IS NULL)
    OR (status = 'dismissed' AND completed_at IS NULL AND dismissed_at IS NOT NULL)
  ),
  CONSTRAINT commitments_due_tuple CHECK (
    (due_precision IN ('instant','date') AND due_at IS NOT NULL AND due_timezone IS NOT NULL AND btrim(due_timezone) <> '' AND due_text IS NOT NULL)
    OR (due_precision = 'unresolved' AND due_at IS NULL AND due_text IS NOT NULL)
    OR (due_precision = 'none' AND due_at IS NULL AND due_timezone IS NULL AND due_text IS NULL)
  )
);
CREATE INDEX commitments_due ON commitments(due_at,priority,created_at,id) WHERE status = 'open' AND due_at IS NOT NULL;

CREATE TABLE mind_changes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_id uuid,
  memory_id uuid,
  commitment_id uuid,
  entity_version bigint NOT NULL CONSTRAINT changes_version_positive CHECK (entity_version >= 1),
  operation text NOT NULL CONSTRAINT changes_operation_check CHECK (operation IN ('create','update','delete','complete','dismiss','reopen','release_override')),
  actor text NOT NULL CONSTRAINT changes_actor_check CHECK (actor IN ('reconciler','user')),
  after_state jsonb NOT NULL CONSTRAINT changes_after_state_object CHECK (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT changes_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT changes_one_target CHECK ((memory_id IS NOT NULL) <> (commitment_id IS NOT NULL)),
  CONSTRAINT changes_job_actor CHECK ((actor = 'reconciler') = (job_id IS NOT NULL)),
  CONSTRAINT changes_job_fk FOREIGN KEY (user_id,job_id) REFERENCES reconciliation_jobs(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT changes_memory_fk FOREIGN KEY (user_id,memory_id) REFERENCES memories(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT changes_commitment_fk FOREIGN KEY (user_id,commitment_id) REFERENCES commitments(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT changes_unique_memory_version UNIQUE (memory_id,entity_version),
  CONSTRAINT changes_unique_commitment_version UNIQUE (commitment_id,entity_version),
  CONSTRAINT changes_unique_user_commitment_version UNIQUE (user_id,commitment_id,entity_version)
);

CREATE TABLE change_sources (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  change_id uuid NOT NULL,
  transcript_part_id uuid NOT NULL,
  evidence_text text NOT NULL CONSTRAINT sources_evidence_nonempty CHECK (btrim(evidence_text) <> ''),
  PRIMARY KEY (change_id,transcript_part_id),
  CONSTRAINT sources_change_fk FOREIGN KEY (user_id,change_id) REFERENCES mind_changes(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT sources_part_fk FOREIGN KEY (user_id,transcript_part_id) REFERENCES transcript_parts(user_id,id) ON DELETE RESTRICT
);

CREATE TABLE commitment_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  schedule_version bigint NOT NULL CONSTRAINT logs_schedule_positive CHECK (schedule_version >= 1),
  commitment_version bigint NOT NULL CONSTRAINT logs_commitment_version_positive CHECK (commitment_version >= 1),
  due_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  priority smallint NOT NULL CONSTRAINT logs_priority_check CHECK (priority BETWEEN 1 AND 3),
  title_snapshot text NOT NULL,
  batch_id uuid NOT NULL,
  batch_position integer NOT NULL CONSTRAINT logs_batch_position_positive CHECK (batch_position >= 1),
  emitted_at timestamptz,
  emit_attempts integer NOT NULL DEFAULT 0 CONSTRAINT logs_attempts_nonnegative CHECK (emit_attempts >= 0),
  emit_available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  CONSTRAINT logs_unique_user_id UNIQUE (user_id,id),
  CONSTRAINT logs_commitment_fk FOREIGN KEY (user_id,commitment_id) REFERENCES commitments(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT logs_change_fk FOREIGN KEY (user_id,commitment_id,commitment_version) REFERENCES mind_changes(user_id,commitment_id,entity_version) ON DELETE RESTRICT,
  CONSTRAINT logs_unique_schedule UNIQUE (commitment_id,schedule_version),
  CONSTRAINT logs_unique_batch_position UNIQUE (batch_id,batch_position)
);
CREATE INDEX logs_unemitted ON commitment_logs(emit_available_at) WHERE emitted_at IS NULL;
