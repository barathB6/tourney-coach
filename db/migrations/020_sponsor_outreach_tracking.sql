-- Outreach engine tracking: when an email was sent, how many follow-ups
-- have gone out, and engagement signals reported back by SendGrid's event
-- webhook (open/click). Used to drive the 7-day/2-attempt follow-up cadence
-- and to stop follow-ups automatically once a sponsor responds.

alter table sponsors add column if not exists outreach_sent_at timestamptz;
alter table sponsors add column if not exists follow_up_count integer not null default 0;
alter table sponsors add column if not exists email_opens integer not null default 0;
alter table sponsors add column if not exists email_clicks integer not null default 0;
alter table sponsors add column if not exists last_opened_at timestamptz;
alter table sponsors add column if not exists last_clicked_at timestamptz;
alter table sponsors add column if not exists sendgrid_message_id text;

create index if not exists idx_sponsors_followup_due
  on sponsors(status, outreach_sent_at)
  where status = 'contacted';
