-- Reply tracking for sponsorship outreach. When a prospect replies to an
-- outreach email, SendGrid Inbound Parse posts it to our webhook, which marks
-- the prospect "replied" (stopping the follow-up cadence, which only targets
-- "contacted") and stores a snippet for the organizer.

-- 'replied' is a new status value — widen the existing check constraint.
alter table sponsors drop constraint if exists sponsors_status_check;
alter table sponsors add constraint sponsors_status_check
  check (status in ('not_contacted', 'contacted', 'no_reply', 'replied', 'verbal', 'invoiced', 'pending', 'paid', 'declined'));

alter table sponsors add column if not exists replied_at timestamptz;
alter table sponsors add column if not exists reply_snippet text;
