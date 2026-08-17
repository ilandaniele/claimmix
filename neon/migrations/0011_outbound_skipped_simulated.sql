-- Migration 0011: allow 'skipped_simulated' in outbound_messages.status
--
-- Dispatch now records what it WOULD have sent to an IANA-reserved example.*
-- address instead of returning without a trace, so seeding test data actually
-- exercises the post-extraction flow. That row is not queued, not sent and not
-- failed — it is a preview of a message deliberately never delivered — and the
-- existing CHECK rejected it, which silently killed every preview insert.
--
-- Kept out of the 'sent' set on purpose: replied_at counts only 'sent', so a
-- simulated case must never read as though the claimant was answered.

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_status_check;

ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'skipped_simulated'));
