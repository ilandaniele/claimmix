-- What each outgoing message actually asked for.
--
-- Every inbound message starts a fresh round, and a round that finds the same
-- gap sends the same request again. A claimant answered one question and then
-- forwarded a contact card, and got three messages in ninety seconds all
-- asking for the friendly accident report. The prose differed each time — the
-- composer rewrites it — so nothing downstream could tell they were the same
-- request.
--
-- Storing the keys makes "we have already asked exactly this" a fact the code
-- can check instead of a shape a human notices in a screenshot.

ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS asked_keys text[];

COMMENT ON COLUMN outbound_messages.asked_keys IS
  'Field and document keys this message asked for, in the order shown. NULL for messages that ask for nothing.';
