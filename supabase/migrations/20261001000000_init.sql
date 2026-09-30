-- Content agent schema. This is the content agent's OWN Supabase project,
-- never the Property Potential app's.
--
-- Access model for the MVP: only the pipeline (service role, on krish's
-- machine or the worker) reads and writes. RLS is on with no policies, so the
-- anon and authenticated roles see nothing.

create table public.content_items (
  id text primary key,
  status text not null check (status in (
    'draft', 'qc_failed', 'not_worth_it', 'in_review', 'changes_requested',
    'approved', 'rejected', 'scheduled', 'published')),
  source jsonb,            -- SourceBundle: listing URL, text snapshot ref, user facts, photo rights
  angles jsonb not null default '[]'::jsonb,
  chosen_angle_id text,
  script jsonb,            -- lines with fact ids, caption, hashtags, title
  script_issues jsonb not null default '[]'::jsonb,
  shots jsonb not null default '[]'::jsonb,
  voice jsonb not null default '[]'::jsonb,
  photo_labels jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.facts (
  id text primary key,
  content_item_id text not null references public.content_items (id) on delete cascade,
  field text not null,
  label text not null,
  value jsonb not null,
  unit text,
  -- Same vocabulary as the Property Potential app's field_provenance.
  status text not null check (status in ('VERIFIED', 'ESTIMATE', 'AI_SUGGESTION', 'USER_SUPPLIED', 'UNKNOWN')),
  scope text not null default 'none' check (scope in ('as_advertised', 'independent', 'none')),
  sources jsonb not null default '[]'::jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null
);
create index facts_content_item_idx on public.facts (content_item_id);

create table public.assets (
  id text primary key,
  content_item_id text not null references public.content_items (id) on delete cascade,
  kind text not null check (kind in (
    'photo', 'ai_image', 'ai_video', 'voice_line', 'render', 'thumbnail', 'captions', 'snapshot')),
  bucket text,
  path text not null,
  origin text not null check (origin in ('original', 'derived', 'ai_generated', 'tts', 'render')),
  derived_from text,
  -- Photos must be owned or used with explicit permission; never scraped listing photos.
  rights text not null check (rights in ('owned', 'permission', 'generated', 'n/a')),
  width integer,
  height integer,
  duration_sec numeric,
  sha256 text,
  meta jsonb not null default '{}'::jsonb
);
create index assets_content_item_idx on public.assets (content_item_id);

create table public.renders (
  id text primary key,
  content_item_id text not null references public.content_items (id) on delete cascade,
  version integer not null,
  video_asset_id text not null,
  thumbnail_asset_id text not null,
  captions_asset_id text not null,
  duration_sec numeric not null,
  mock_providers jsonb not null default '[]'::jsonb,
  qc jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (content_item_id, version)
);

create table public.reviews (
  id text primary key,
  content_item_id text not null references public.content_items (id) on delete cascade,
  render_id text not null references public.renders (id) on delete cascade,
  decision text not null check (decision in ('approved', 'changes_requested', 'rejected')),
  note text not null default '',
  reviewer text not null,
  created_at timestamptz not null default now()
);

-- One row per stage run: status, error, provider cost.
create table public.jobs (
  content_item_id text not null references public.content_items (id) on delete cascade,
  stage text not null,
  started_at timestamptz not null,
  status text not null check (status in ('ok', 'failed', 'skipped')),
  finished_at timestamptz not null,
  error text,
  cost_usd numeric not null default 0,
  providers jsonb not null default '[]'::jsonb,
  primary key (content_item_id, stage, started_at)
);

-- Later phases (publishing, analytics) add: publications, metric_snapshots, learnings.

-- A content item can only be approved when an approving review exists for its latest render.
create function public.guard_approval() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    if not exists (
      select 1
      from public.reviews r
      join public.renders rd on rd.id = r.render_id
      where r.content_item_id = new.id
        and r.decision = 'approved'
        and rd.version = (select max(version) from public.renders where content_item_id = new.id)
    ) then
      raise exception 'content item % has no approving review for its latest render', new.id
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger content_items_guard_approval
  before insert or update of status on public.content_items
  for each row execute function public.guard_approval();

alter table public.content_items enable row level security;
alter table public.facts enable row level security;
alter table public.assets enable row level security;
alter table public.renders enable row level security;
alter table public.reviews enable row level security;
alter table public.jobs enable row level security;

-- Private buckets. Files are stored as {content_item_id}/{path}.
insert into storage.buckets (id, name, public) values
  ('source-snapshots', 'source-snapshots', false),
  ('photos', 'photos', false),
  ('generated', 'generated', false),
  ('renders', 'renders', false)
on conflict (id) do nothing;
