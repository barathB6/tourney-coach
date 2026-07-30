-- Day 26 — Tournament Operations Center foundation.
--
-- The TOC tables were pasted straight into Supabase as part of the Day 2 spec
-- schema, so their shape lives only in the database and nothing in this repo
-- describes them. This migration brings them under version control and adds
-- what the Operations Center actually needs.
--
-- The central idea is the PHASE distinction. Planning work spans 12–16 weeks;
-- day-of work spans about four hours. They are the same underlying
-- role/task/assignment machinery pointed at two very different clocks, so
-- phase is a first-class column rather than a naming convention — otherwise
-- every query that wants "what do I do today" has to guess from a title.
--
-- Both phases measure due_offset_hours as HOURS BEFORE THE EVENT (negative =
-- before, positive = after). What differs is the anchor:
--   planning  → anchored to the event date        (-2688h = 16 weeks out)
--   day_of    → anchored to the shotgun start time (-2h = two hours before)
-- One unit, one column, two scales. That is the whole phase-distinct engine.
--
-- Safe to re-run.

-- ── Phase on the role library ───────────────────────────────────────────────
alter table public.role_templates
  add column if not exists phase text not null default 'planning',
  add column if not exists sort_order integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'role_templates_phase_check') then
    alter table public.role_templates
      add constraint role_templates_phase_check check (phase in ('planning', 'day_of'));
  end if;
  -- Seeding is by name, so the name has to be the identity.
  if not exists (select 1 from pg_constraint where conname = 'role_templates_name_key') then
    alter table public.role_templates add constraint role_templates_name_key unique (name);
  end if;
end $$;

alter table public.task_templates
  add column if not exists phase text not null default 'planning',
  add column if not exists sort_order integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_templates_phase_check') then
    alter table public.task_templates
      add constraint task_templates_phase_check check (phase in ('planning', 'day_of'));
  end if;
  -- Lets the seed below be idempotent instead of duplicating tasks each run.
  if not exists (select 1 from pg_constraint where conname = 'task_templates_role_title_key') then
    alter table public.task_templates
      add constraint task_templates_role_title_key unique (role_template_id, title);
  end if;
end $$;

-- ── Assignments: who actually took the role ─────────────────────────────────
alter table public.tournament_volunteer_assignments
  add column if not exists status text not null default 'assigned',
  add column if not exists notes text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tva_status_check') then
    alter table public.tournament_volunteer_assignments
      add constraint tva_status_check check (status in ('assigned', 'confirmed', 'declined', 'completed'));
  end if;
end $$;

-- One person holds a given role once per tournament. Without this, a
-- double-click on "assign" silently produces two rows and the "roles filled"
-- goal reads as met when it isn't.
create unique index if not exists tva_one_role_per_volunteer
  on public.tournament_volunteer_assignments (tournament_id, volunteer_id, role_template_id);

create index if not exists tva_tournament_idx
  on public.tournament_volunteer_assignments (tournament_id);

-- ── Tournament Goals Dashboard ──────────────────────────────────────────────
-- The five numbers an organizer is actually judged on. One row per tournament;
-- progress is always DERIVED from live data (registrations, sponsors,
-- donation_prospects, assignments) rather than stored, so a goal can never
-- drift out of step with reality.
--
-- sponsorship_goal_cents is deliberately separate from
-- tournaments.fundraising_goal_cents: the latter is the whole event's raise,
-- this is the slice the sponsorship committee owns.
create table if not exists public.tournament_goals (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null unique references public.tournaments(id) on delete cascade,
  player_goal integer,
  sponsorship_goal_cents integer,
  donation_items_goal integer,
  marketing_reach_goal integer,
  volunteer_roles_goal integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Seed: planning-phase role library (11 roles) ────────────────────────────
insert into public.role_templates (name, description, phase, sort_order) values
  ('Sponsorship Committee Chair', 'Owns the sponsorship number. Builds the tier sheet, runs the prospect list, and closes the money.', 'planning', 10),
  ('Donation Outreach Lead',      'Secures in-kind donations — gift bags, prizes, raffle items — and keeps the tax receipts straight.', 'planning', 20),
  ('Marketing Coordinator',       'Gets the event in front of people: microsite, social, local press, email.', 'planning', 30),
  ('Player Recruitment Captain',  'Fills the field. Works last year''s players first, then corporate foursomes, then the gaps.', 'planning', 40),
  ('Communications Lead',         'Every message that leaves the committee — players, sponsors, volunteers — on one cadence.', 'planning', 50),
  ('Course Liaison',              'The single point of contact with the pro shop. Date, tee sheet, carts, contest holes, final headcount.', 'planning', 60),
  ('Logistics Lead',              'Signage, rentals, load-in, and the day-of run sheet.', 'planning', 70),
  ('Volunteer Coordinator',       'Recruits the day-of crew, assigns roles, and briefs them before they arrive.', 'planning', 80),
  ('Cause Story Lead',            'Owns the why. Interviews the beneficiary, writes the story, gathers photos and permissions.', 'planning', 90),
  ('Auction Item Hunter',         'Finds the headline auction items and everything under them.', 'planning', 100),
  ('Goal Tracker',                'Watches the five tournament goals weekly and flags what is falling behind while there is still time.', 'planning', 110)
on conflict (name) do update
  set description = excluded.description,
      phase       = excluded.phase,
      sort_order  = excluded.sort_order;

-- ── Seed: day-of role library (9 roles) ─────────────────────────────────────
insert into public.role_templates (name, description, phase, sort_order) values
  ('Registration Lead',      'Runs the check-in table. First face every player sees, and the person who reconciles the cash box.', 'day_of', 10),
  ('Registration Volunteer', 'Checks players in, hands out gift bags, points people at their carts.', 'day_of', 20),
  ('Beverage Cart Driver',   'Keeps the cart stocked and moving. Pace of play depends on this more than people expect.', 'day_of', 30),
  ('Contest Hole Monitor',   'Witnesses and records closest-to-pin, long drive, and hole-in-one attempts.', 'day_of', 40),
  ('Scoring Runner',         'Collects cards at the turn and at the finish so the leaderboard stays live.', 'day_of', 50),
  ('Kitchen Liaison',        'The bridge to the kitchen. Confirms headcount and relays the finish-time alert.', 'day_of', 60),
  ('Awards Setup Crew',      'Stages trophies, prizes, and AV while the last groups are still out.', 'day_of', 70),
  ('Photographer',           'Team photos at registration, action on course, sponsors and winners at awards.', 'day_of', 80),
  ('Takedown Crew',          'Signage in, equipment loaded, final walkthrough of the course.', 'day_of', 90)
on conflict (name) do update
  set description = excluded.description,
      phase       = excluded.phase,
      sort_order  = excluded.sort_order;

-- ── Seed: task templates ────────────────────────────────────────────────────
-- due_offset_hours is hours relative to the anchor for that phase (see header).
-- Planning uses week multiples: 168h = 1 week.
do $$
declare
  r record;
  t record;
  seed jsonb := $seed$
  {
    "Sponsorship Committee Chair": [
      ["Build the sponsorship tier sheet", -2688],
      ["Draft a prospect list of 40+ local businesses", -2352],
      ["Send the first outreach wave", -2016],
      ["Follow up with everyone who has not replied", -1512],
      ["Lock sponsor logos for signage", -672],
      ["Confirm every sponsor payment has landed", -336]
    ],
    "Donation Outreach Lead": [
      ["Build the donation prospect list", -2352],
      ["Ask local businesses for in-kind donations", -2016],
      ["Collect donation letters and tax receipts", -1176],
      ["Inventory everything received", -504]
    ],
    "Marketing Coordinator": [
      ["Publish the tournament microsite", -2016],
      ["Announce the event with the cause story", -1848],
      ["Mid-campaign push to fill remaining spots", -1008],
      ["Final week countdown posts", -168]
    ],
    "Player Recruitment Captain": [
      ["Personal asks to last year's players", -2016],
      ["Corporate foursome outreach", -1680],
      ["Push to fill the last open spots", -504]
    ],
    "Communications Lead": [
      ["Draft the player confirmation email", -1344],
      ["Start the weekly committee update", -1176],
      ["Send the know-before-you-go email", -168]
    ],
    "Course Liaison": [
      ["Confirm date and shotgun time with the pro shop", -2688],
      ["Walk the course and mark contest holes", -672],
      ["Confirm cart count and range balls", -336],
      ["Give the pro shop the final headcount", -72]
    ],
    "Logistics Lead": [
      ["Order signage and banners", -1008],
      ["Confirm rentals: tables, tents, PA", -672],
      ["Build the day-of run sheet", -336],
      ["Set the load-in plan and vehicle assignments", -48]
    ],
    "Volunteer Coordinator": [
      ["Recruit the day-of volunteer crew", -1344],
      ["Assign roles and confirm each person", -504],
      ["Send the volunteer briefing", -72]
    ],
    "Cause Story Lead": [
      ["Interview the beneficiary family", -2352],
      ["Write the cause story", -2016],
      ["Collect photos and written permissions", -1512],
      ["Prepare the awards ceremony remarks", -168]
    ],
    "Auction Item Hunter": [
      ["Set the auction item target", -2352],
      ["Secure the headline item", -1680],
      ["Photograph and describe every item", -672],
      ["Set up the display and bid sheets", -24]
    ],
    "Goal Tracker": [
      ["Set the five tournament goals", -2688],
      ["Run the weekly goal review", -1512],
      ["Flag at-risk goals to the organizer", -504],
      ["Deliver the final push report", -168]
    ],
    "Registration Lead": [
      ["Arrive and set up the check-in table", -2],
      ["Brief the registration volunteers", -1],
      ["Open registration", -1],
      ["Reconcile the cash box", 1]
    ],
    "Registration Volunteer": [
      ["Arrive and get your assignment", -2],
      ["Check players in and hand out gift bags", -1],
      ["Direct players to their carts", 0]
    ],
    "Beverage Cart Driver": [
      ["Stock the cart", -1],
      ["Begin the course rotation", 0],
      ["Restock mid-round", 2]
    ],
    "Contest Hole Monitor": [
      ["Set up contest signage and markers", -1],
      ["Witness and record every entry", 0],
      ["Report the winner to scoring", 3]
    ],
    "Scoring Runner": [
      ["Confirm access to the scoring app", -1],
      ["Collect scores at the turn", 2],
      ["Deliver the final cards to scoring", 4]
    ],
    "Kitchen Liaison": [
      ["Confirm the headcount with the kitchen", -2],
      ["Relay the 45-minute finish alert", 3],
      ["Confirm service start", 4]
    ],
    "Awards Setup Crew": [
      ["Stage trophies and prizes", 3],
      ["Set up AV for the remarks", 3],
      ["Run the awards ceremony", 4]
    ],
    "Photographer": [
      ["Team photos at registration", -1],
      ["On-course action shots", 1],
      ["Awards and sponsor photos", 4]
    ],
    "Takedown Crew": [
      ["Collect course signage", 4],
      ["Load out equipment", 5],
      ["Final walkthrough of the course", 5]
    ]
  }
  $seed$;
begin
  for r in select id, name, phase from public.role_templates loop
    if seed ? r.name then
      for t in select * from jsonb_array_elements(seed -> r.name) with ordinality as x(item, ord) loop
        insert into public.task_templates (role_template_id, title, due_offset_hours, phase, sort_order)
        values (r.id, t.item ->> 0, (t.item ->> 1)::integer, r.phase, (t.ord * 10)::integer)
        on conflict (role_template_id, title) do update
          set due_offset_hours = excluded.due_offset_hours,
              phase            = excluded.phase,
              sort_order       = excluded.sort_order;
      end loop;
    end if;
  end loop;
end $$;

-- ── Access ──────────────────────────────────────────────────────────────────
-- Consistent with migration 025: the browser never touches these directly.
-- Every read and write goes through an owner-checked API route on the service
-- role. Granting service_role explicitly because relying on default privileges
-- is what made migration 038 look like it had silently done nothing.
alter table public.tournament_goals enable row level security;
revoke all on public.tournament_goals from anon, authenticated;
grant all on public.tournament_goals to service_role;
grant all on public.role_templates, public.task_templates,
             public.tournament_volunteer_assignments to service_role;

notify pgrst, 'reload schema';

-- Verification. Expect 11 planning roles, 9 day-of roles, and every role
-- carrying at least one task.
select
  (select count(*) from public.role_templates where phase = 'planning')            as planning_roles,
  (select count(*) from public.role_templates where phase = 'day_of')              as day_of_roles,
  (select count(*) from public.task_templates where phase = 'planning')            as planning_tasks,
  (select count(*) from public.task_templates where phase = 'day_of')              as day_of_tasks,
  (select count(*) from public.role_templates r
     where not exists (select 1 from public.task_templates t where t.role_template_id = r.id)) as roles_without_tasks,
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'tournament_goals')            as goals_table;
