create table if not exists users (
  id text primary key,
  email text not null,
  plan_tier text not null default 'starter',
  daily_budget_cents integer not null default 5000,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key,
  user_id text not null references users(id),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists beta_access_requests (
  id uuid primary key,
  name text,
  email text,
  phone text,
  note text,
  ip_hash text,
  user_agent text,
  invite_code_id uuid,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists beta_access_requests
  add column if not exists ip_hash text;

alter table if exists beta_access_requests
  add column if not exists user_agent text;

alter table if exists beta_access_requests
  add column if not exists invite_code_id uuid;

create unique index if not exists beta_access_requests_email_unique_idx
  on beta_access_requests (lower(email))
  where email is not null;

create unique index if not exists beta_access_requests_phone_unique_idx
  on beta_access_requests (phone)
  where phone is not null;

create table if not exists beta_invite_codes (
  id uuid primary key,
  access_request_id uuid references beta_access_requests(id),
  code_hash text not null unique,
  email text,
  phone text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists beta_invite_codes_request_idx
  on beta_invite_codes(access_request_id, created_at desc);

create table if not exists provider_audit_events (
  id uuid primary key,
  user_id text not null,
  project_id uuid,
  video_job_id uuid,
  media_generation_id uuid,
  media_session_id uuid,
  provider text not null,
  model text not null,
  status text not null,
  estimated_cost_cents integer not null default 0,
  actual_cost_cents integer not null default 0,
  daily_spent_cents integer,
  daily_budget_cents integer,
  global_spent_cents integer,
  global_budget_cents integer,
  request_id text,
  idempotency_key text,
  billing_key text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists provider_audit_events_created_idx
  on provider_audit_events(created_at desc);

create index if not exists provider_audit_events_user_created_idx
  on provider_audit_events(user_id, created_at desc);

alter table if exists provider_audit_events
  add column if not exists billing_key text;

create unique index if not exists provider_audit_events_billing_key_unique_idx
  on provider_audit_events(billing_key)
  where billing_key is not null;

create table if not exists beta_feedback (
  id uuid primary key,
  user_id text not null references users(id),
  project_id uuid,
  video_job_id uuid,
  media_session_id uuid,
  kind text not null,
  message text not null,
  status text not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists beta_feedback_created_idx
  on beta_feedback(created_at desc);

create index if not exists beta_feedback_user_created_idx
  on beta_feedback(user_id, created_at desc);

create table if not exists video_jobs (
  id uuid primary key,
  project_id uuid not null references projects(id),
  user_id text not null references users(id),
  status text not null,
  current_phase integer not null,
  prompt text not null,
  estimated_cost_cents integer not null,
  actual_cost_cents integer not null default 0,
  recovery_budget_cents integer not null default 0,
  recovery_spent_cents integer not null default 0,
  aspect_ratio text not null,
  visual_mode text not null default 'conceptual',
  duration_seconds integer not null,
  trace_id text not null,
  content_type text not null default 'music_video',
  quality_tier text not null default 'standard',
  workflow_version text not null default 'music-video-v1',
  cancellation_requested boolean not null default false,
  source_bundle jsonb,
  digest_mode text,
  research_mode text,
  presentation_mode text,
  visual_style_preset text not null default 'auto',
  visual_plan jsonb,
  editorial_plan jsonb,
  duration_plan jsonb,
  storyboard jsonb,
  approvals jsonb not null default '[]'::jsonb,
  timeline_manifest jsonb,
  qa_report jsonb,
  script text,
  narration_asset_id uuid,
  music_controls jsonb,
  seeds jsonb not null default '{"subjects":[],"aesthetic":[]}'::jsonb,
  creative_brief jsonb,
  music_plan jsonb,
  music_track jsonb,
  beat_grid jsonb,
  anchor_assets jsonb not null default '[]'::jsonb,
  shot_plan jsonb,
  generated_shots jsonb not null default '[]'::jsonb,
  render_manifest jsonb,
  final_video_url text,
  thumbnail_url text,
  prompt_trace jsonb,
  edit_directives jsonb not null default '[]'::jsonb,
  artifact_versions jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists video_jobs
  add column if not exists edit_directives jsonb not null default '[]'::jsonb;

alter table if exists video_jobs
  add column if not exists recovery_budget_cents integer not null default 0;

alter table if exists video_jobs
  add column if not exists recovery_spent_cents integer not null default 0;

alter table if exists video_jobs
  add column if not exists artifact_versions jsonb not null default '[]'::jsonb;

alter table if exists video_jobs
  add column if not exists prompt_trace jsonb;

alter table if exists video_jobs
  add column if not exists content_type text not null default 'music_video';

alter table if exists video_jobs
  add column if not exists quality_tier text not null default 'standard';

alter table if exists video_jobs
  add column if not exists workflow_version text not null default 'music-video-v1';

alter table if exists video_jobs
  add column if not exists source_bundle jsonb;

alter table if exists video_jobs
  add column if not exists digest_mode text;

alter table if exists video_jobs
  add column if not exists research_mode text;

alter table if exists video_jobs
  add column if not exists presentation_mode text;

alter table if exists video_jobs
  add column if not exists visual_style_preset text not null default 'auto';

alter table if exists video_jobs
  add column if not exists visual_plan jsonb;

alter table if exists video_jobs
  add column if not exists editorial_plan jsonb;

alter table if exists video_jobs
  add column if not exists duration_plan jsonb;

alter table if exists video_jobs
  add column if not exists storyboard jsonb;

alter table if exists video_jobs
  add column if not exists approvals jsonb not null default '[]'::jsonb;

alter table if exists video_jobs
  add column if not exists timeline_manifest jsonb;

alter table if exists video_jobs
  add column if not exists qa_report jsonb;

alter table if exists video_jobs
  add column if not exists script text;

alter table if exists video_jobs
  add column if not exists narration_asset_id uuid;

alter table if exists video_jobs
  add column if not exists visual_mode text not null default 'conceptual';

alter table if exists video_jobs
  add column if not exists music_controls jsonb;

alter table if exists video_jobs
  add column if not exists seeds jsonb not null default '{"subjects":[],"aesthetic":[]}'::jsonb;

create table if not exists workflow_phases (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  phase_number integer not null,
  name text not null,
  state text not null,
  started_at timestamptz,
  completed_at timestamptz,
  artifact_url text,
  error text,
  unique(video_job_id, phase_number)
);

create table if not exists workflow_steps (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  step_id text not null,
  name text not null,
  state text not null,
  depends_on jsonb not null default '[]'::jsonb,
  artifact_version_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  unique(video_job_id, step_id)
);

create index if not exists workflow_steps_job_idx
  on workflow_steps(video_job_id, step_id);

create table if not exists production_workflow_runs (
  id uuid primary key,
  production_id uuid not null references video_jobs(id),
  run_id text not null unique,
  kind text not null,
  workflow_version text not null,
  state text not null,
  recovery_token text,
  error_code text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  heartbeat_at timestamptz not null,
  completed_at timestamptz
);

create index if not exists production_workflow_runs_production_idx
  on production_workflow_runs(production_id, started_at desc);

create table if not exists production_sources (
  id uuid primary key,
  project_id uuid not null references projects(id),
  production_id uuid references video_jobs(id),
  user_id text not null references users(id),
  kind text not null,
  title text not null,
  original_name text,
  source_url text,
  canonical_url text,
  blob_url text,
  mime_type text,
  byte_size bigint,
  sha256 text,
  page_count integer,
  published_at timestamptz,
  retrieved_at timestamptz,
  supplied_at timestamptz not null,
  rights text not null,
  processing_state text not null default 'pending',
  extraction_version text not null default 'source-v1',
  warnings jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists production_sources_project_idx
  on production_sources(project_id, created_at desc);

create index if not exists production_sources_production_idx
  on production_sources(production_id, created_at);

create unique index if not exists production_sources_project_sha_idx
  on production_sources(project_id, sha256)
  where sha256 is not null;

create table if not exists source_fragments (
  id uuid primary key,
  source_id uuid not null references production_sources(id) on delete cascade,
  ordinal integer not null,
  page_number integer,
  section text,
  text_content text not null,
  text_hash text not null,
  extraction_method text not null,
  created_at timestamptz not null default now(),
  unique(source_id, ordinal)
);

create index if not exists source_fragments_source_idx
  on source_fragments(source_id, ordinal);

create table if not exists provider_calls (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  phase_number integer not null,
  provider text not null,
  model text not null,
  request_id text not null,
  idempotency_key text not null,
  latency_ms integer not null,
  cost_cents integer not null,
  status text not null,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(video_job_id, idempotency_key)
);

alter table if exists provider_calls
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists assets (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  kind text not null,
  role text not null,
  url text not null,
  mime_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  c2pa_claim text,
  created_at timestamptz not null default now()
);

create table if not exists media_generations (
  id uuid primary key,
  project_id uuid not null references projects(id),
  video_job_id uuid references video_jobs(id),
  kind text not null,
  provider text not null,
  model text not null,
  status text not null,
  prompt text not null,
  controls jsonb not null default '{}'::jsonb,
  input_asset_ids jsonb not null default '[]'::jsonb,
  output_urls jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  cost_cents integer not null default 0,
  request_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists media_assets (
  id uuid primary key,
  project_id uuid not null references projects(id),
  video_job_id uuid references video_jobs(id),
  generation_id uuid references media_generations(id),
  kind text not null,
  role text not null,
  url text not null,
  mime_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table if exists media_assets
  add column if not exists deleted_at timestamptz;

create table if not exists library_assets (
  id uuid primary key,
  user_id text not null references users(id),
  kind text not null,
  name text not null,
  role text not null,
  url text not null,
  mime_type text not null,
  source text not null,
  tags jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  favorite_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table if exists library_assets
  add column if not exists deleted_at timestamptz;

alter table if exists library_assets
  add column if not exists favorite_at timestamptz;

create table if not exists library_collections (
  id uuid primary key,
  user_id text not null references users(id),
  name text not null,
  metadata jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists library_collection_assets (
  id uuid primary key,
  collection_id uuid not null references library_collections(id),
  library_asset_id uuid not null references library_assets(id),
  created_at timestamptz not null default now(),
  unique(collection_id, library_asset_id)
);

create table if not exists project_asset_links (
  id uuid primary key,
  project_id uuid not null references projects(id),
  library_asset_id uuid not null references library_assets(id),
  media_asset_id uuid not null references media_assets(id),
  created_at timestamptz not null default now(),
  unique(project_id, library_asset_id)
);

create table if not exists media_sessions (
  id uuid primary key,
  project_id uuid not null references projects(id),
  kind text not null,
  title text not null,
  status text not null default 'active',
  source_asset_id uuid references media_assets(id),
  current_asset_id uuid references media_assets(id),
  goal text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists media_session_versions (
  id uuid primary key,
  session_id uuid not null references media_sessions(id),
  asset_id uuid not null references media_assets(id),
  generation_id uuid references media_generations(id),
  label text not null,
  prompt text,
  controls jsonb not null default '{}'::jsonb,
  parent_version_id uuid references media_session_versions(id),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists media_session_messages (
  id uuid primary key,
  session_id uuid not null references media_sessions(id),
  role text not null,
  content text not null,
  proposal jsonb,
  generation_id uuid references media_generations(id),
  version_id uuid references media_session_versions(id),
  action_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists media_generations_project_created_idx
  on media_generations(project_id, created_at desc);

create index if not exists media_assets_project_created_idx
  on media_assets(project_id, created_at desc);

create index if not exists library_assets_user_created_idx
  on library_assets(user_id, created_at desc);

create index if not exists library_assets_user_favorite_idx
  on library_assets(user_id, favorite_at desc)
  where favorite_at is not null and deleted_at is null;

create index if not exists library_collections_user_created_idx
  on library_collections(user_id, created_at desc)
  where archived_at is null;

create index if not exists library_collection_assets_collection_idx
  on library_collection_assets(collection_id, created_at desc);

create index if not exists media_sessions_project_updated_idx
  on media_sessions(project_id, updated_at desc);

create index if not exists media_session_versions_session_created_idx
  on media_session_versions(session_id, created_at desc);

create index if not exists media_session_messages_session_created_idx
  on media_session_messages(session_id, created_at desc);

create table if not exists shots (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  shot_index integer not null,
  plan jsonb not null,
  generated jsonb,
  qa_score numeric,
  attempts integer not null default 0,
  unique(video_job_id, shot_index)
);

create table if not exists renders (
  id uuid primary key,
  video_job_id uuid not null references video_jobs(id),
  manifest jsonb not null,
  video_url text not null,
  thumbnail_url text,
  duration_seconds numeric not null,
  file_size_bytes bigint,
  created_at timestamptz not null default now()
);

create table if not exists moderation_events (
  id uuid primary key,
  video_job_id uuid references video_jobs(id),
  stage text not null,
  classifier text not null,
  result text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace view ops_provider_daily_costs as
select provider, model, date_trunc('day', created_at) as day, sum(cost_cents) as cost_cents
from provider_calls
group by provider, model, date_trunc('day', created_at);

create or replace view ops_provider_latency as
select provider, model, percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms
from provider_calls
where status = 'success'
group by provider, model;

create or replace view ops_provider_error_rate as
select provider, model,
  avg(case when status = 'failed' then 1 else 0 end) as error_rate
from provider_calls
group by provider, model;

create or replace view ops_jobs_by_phase as
select current_phase, status, count(*) as jobs
from video_jobs
group by current_phase, status;

create or replace view ops_stuck_jobs as
select *
from video_jobs
where status = 'running'
  and updated_at < now() - interval '5 minutes';

-- Hardening migration 1: additive, compatible with existing saved projects.
create table if not exists action_requests (
  user_id text not null,
  scope text not null,
  request_key text not null,
  fingerprint text not null,
  state text not null default 'pending' check (state in ('pending', 'complete')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, request_key)
);
create table if not exists provider_reservations (
  id text primary key,
  user_id text not null,
  scope text not null,
  request_key text not null,
  fingerprint text not null,
  reserved_cents integer not null check (reserved_cents >= 0),
  actual_cents integer not null default 0 check (actual_cents >= 0),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, scope, request_key)
);
create index if not exists provider_reservations_day on provider_reservations (created_at, user_id);
create table if not exists login_attempts (
  key_hash text primary key,
  attempts integer not null,
  resets_at timestamptz not null
);
create table if not exists upload_authorizations (
  id uuid primary key,
  user_id text not null,
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null,
  pathname text not null,
  payload jsonb not null,
  completed_url text,
  created_at timestamptz not null default now()
);
create table if not exists app_schema_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
);
insert into app_schema_migrations(version) values (1) on conflict do nothing;

create table if not exists email_outbox (
  id uuid primary key,
  sender text not null,
  recipient text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
