ALTER TABLE commitments DROP CONSTRAINT commitments_status_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_status_check CHECK (status IN ('open','completed','dismissed','deleted'));
ALTER TABLE commitments DROP CONSTRAINT commitments_status_timestamps;
ALTER TABLE commitments ADD CONSTRAINT commitments_status_timestamps CHECK (
  (status IN ('open','deleted') AND completed_at IS NULL AND dismissed_at IS NULL)
  OR (status = 'completed' AND completed_at IS NOT NULL AND dismissed_at IS NULL)
  OR (status = 'dismissed' AND completed_at IS NULL AND dismissed_at IS NOT NULL)
);

ALTER TABLE commitment_logs ADD COLUMN canceled_at timestamptz;
DROP INDEX logs_unemitted;
CREATE INDEX logs_unemitted ON commitment_logs(emit_available_at) WHERE emitted_at IS NULL AND canceled_at IS NULL;

CREATE TABLE notification_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  commitment_log_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT notification_events_log_fk FOREIGN KEY (user_id,commitment_log_id)
    REFERENCES commitment_logs(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT notification_events_unique_log UNIQUE (commitment_log_id)
);
CREATE INDEX notification_events_user_cursor ON notification_events(user_id,id);
