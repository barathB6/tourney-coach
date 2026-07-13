-- Conversation history for the AI coaching engine.
-- Each organizer can have multiple conversations; messages are ordered by created_at.

create table if not exists coach_conversations (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references auth.users(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete set null,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists coach_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references coach_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Index for fast lookup by organizer
create index if not exists idx_coach_conversations_organizer
  on coach_conversations(organizer_id, updated_at desc);

-- Index for fast message retrieval
create index if not exists idx_coach_messages_conversation
  on coach_messages(conversation_id, created_at asc);

-- RLS
alter table coach_conversations enable row level security;
alter table coach_messages enable row level security;

create policy "Organizers can manage own conversations"
  on coach_conversations for all
  using (organizer_id = auth.uid())
  with check (organizer_id = auth.uid());

create policy "Organizers can manage messages in own conversations"
  on coach_messages for all
  using (
    conversation_id in (
      select id from coach_conversations where organizer_id = auth.uid()
    )
  )
  with check (
    conversation_id in (
      select id from coach_conversations where organizer_id = auth.uid()
    )
  );
