-- ---------------------------------------------------------------------------
-- 0008 — Conversational resolution agent (Phase 2, Milestone F)
--
-- The agent is an alternative UI to the flag review form. It asks the reviewer the
-- open flags one at a time, and may draft a decision; a person applies the draft,
-- and applying it goes through decideFlag like the form. So this migration adds no
-- new decision path — flag status still changes only with a flag_decisions row.
-- What it adds is the record the A/B against the form needs:
--
--   1. agent_conversations — one per (version, reviewer), with start and finish
--      times, so time-to-resolve and completion rate are queries.
--   2. agent_messages — the transcript, append-only apart from a proposal's status.
--      `seq` orders it: a PM message and the reply to it are written in one
--      transaction and share created_at.
--   3. 'agent_turn' joins the llm_calls purpose set, and llm_calls gets
--      agent_conversation_id, so agent spend is separable per conversation — the
--      plan gates the agent on measured cost per ticket.
--   4. The one-run check from 0005 widens to three references: a call belongs to at
--      most one of an analysis run, a compile run or a conversation.
--
-- Same posture as 0001/0003: every table carries tenant_id and has RLS enabled as
-- defense-in-depth; isolation is the repository layer's tenant predicate.
-- ---------------------------------------------------------------------------

begin;

create table agent_conversations (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  user_id            uuid        not null references auth.users (id),
  status             text        not null default 'active'
                                 check (status in ('active', 'completed')),
  -- Set while a model call is in flight for this conversation, so a double-submitted
  -- message cannot start a second paid turn. Cleared when the turn settles; a claim
  -- older than the turn timeout is treated as abandoned.
  turn_started_at    timestamptz,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  unique (tenant_id, ticket_version_id, user_id)
);

create index agent_conversations_ticket_idx on agent_conversations (tenant_id, ticket_id);

create table agent_messages (
  id                 uuid        primary key default gen_random_uuid(),
  seq                bigint      generated always as identity,
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  conversation_id    uuid        not null references agent_conversations (id) on delete cascade,
  -- The flag the message is about. Every message is about exactly one flag.
  flag_id            uuid        not null references flags (id) on delete cascade,
  role               text        not null check (role in ('agent', 'pm')),
  -- question: the agent's deterministic opener for a flag (no model call).
  -- reply:    a model-written answer to a PM message.
  -- message:  a PM message.
  -- decision: the record that a person applied a proposal (or decided the flag).
  kind               text        not null check (kind in ('question', 'reply', 'message', 'decision')),
  content            text        not null,
  -- A reply's drafted decision ({decision, edited_question, resolution_note}).
  proposal           jsonb,
  proposal_status    text        check (proposal_status in ('pending', 'applied', 'declined', 'superseded')),
  -- On a 'decision' row: the decision that was recorded through decideFlag.
  decision           text        check (decision in ('accepted', 'edited', 'dismissed')),
  user_id            uuid        references auth.users (id),
  created_at         timestamptz not null default now(),
  check ((proposal is null) = (proposal_status is null)),
  check ((kind = 'decision') = (decision is not null))
);

create index agent_messages_conversation_idx on agent_messages (tenant_id, conversation_id, seq);

-- One opening question per flag per conversation. The opener is written with the PM's
-- first message about a flag; two tabs sending at once must not write it twice.
create unique index agent_messages_one_question_idx
  on agent_messages (conversation_id, flag_id) where kind = 'question';

alter table llm_calls
  add column agent_conversation_id uuid references agent_conversations (id) on delete cascade;

alter table llm_calls drop constraint llm_calls_purpose_check;
alter table llm_calls add constraint llm_calls_purpose_check
  check (purpose in ('extract', 'critic', 'judge', 'single_shot', 'compile_gherkin', 'embed', 'agent_turn'));

alter table llm_calls drop constraint llm_calls_one_run_check;
alter table llm_calls add constraint llm_calls_one_run_check
  check (num_nonnulls(analysis_run_id, compile_run_id, agent_conversation_id) <= 1);

create index llm_calls_agent_idx on llm_calls (tenant_id, agent_conversation_id);

alter table agent_conversations enable row level security;
alter table agent_messages      enable row level security;

create policy agent_conversations_tenant_all on agent_conversations
  for all
  using (specfix_member_of(tenant_id))
  with check (specfix_member_of(tenant_id));

create policy agent_messages_tenant_all on agent_messages
  for all
  using (specfix_member_of(tenant_id))
  with check (specfix_member_of(tenant_id));

commit;
