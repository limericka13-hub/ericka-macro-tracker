-- Ericka's Macro Tracker - database schema
--
-- Paste into the SQL editor of HER Supabase project and run once. Safe to run
-- again: every statement skips what already exists.
--
-- Derived from how app.js reads and writes each table. The quoted mixed-case
-- column names are load-bearing: Postgres folds unquoted identifiers to lower
-- case, and the app reads them with the exact capitalisation below. Get one
-- wrong and reads come back null instead of erroring, which is a slow and
-- confusing failure.

-- ---------------------------------------------------------------------------
-- Macro targets. Exactly one row, ever.
-- id is GENERATED ALWAYS on purpose: the app only ever UPDATEs this row, and
-- Postgres rejecting an explicit id is what stops a stray upsert creating a
-- second set of targets.
-- ---------------------------------------------------------------------------
create table if not exists public.macro_targets (
  id      integer generated always as identity primary key,
  kcal    numeric not null default 2000,
  protein numeric not null default 180,
  carbs   numeric not null default 200,
  fat     numeric not null default 55
);

-- ---------------------------------------------------------------------------
-- Saved foods, per 'Quantity' grams. barcode is only set when a food was added
-- by scanning.
-- ---------------------------------------------------------------------------
create table if not exists public.macro_food_database (
  id         uuid primary key default gen_random_uuid(),
  "Item"     text not null,
  "Quantity" numeric not null default 100,
  "Kcal"     numeric not null default 0,
  "Protein"  numeric not null default 0,
  "Carb"     numeric not null default 0,
  "Fat"      numeric not null default 0,
  barcode    text
);

-- ---------------------------------------------------------------------------
-- Daily logs. 'Items Logged' is a JSON string, not jsonb - the app
-- JSON.stringify()s on write and JSON.parse()s on read, so keep it text.
--
-- Four reserved rows share this table with the real days:
--   ...000000000001  'ACTIVE_DRAFT'     the current day's meals
--   ...000000000002  'BUILDER_DRAFT'    the half-built meal
--   ...000000000003  'CALORIE_CARRIES'  carried surplus/deficit and planned days
--   ...000000000004  'FOOD_UNITS'       each food's serving type (g, ml, unit...)
--                                       and exact decimal serving size
-- The primary key on id is what upsert(..., { onConflict: 'id' }) relies on.
-- ---------------------------------------------------------------------------
create table if not exists public.macro_daily_logs (
  id              uuid primary key default gen_random_uuid(),
  "Log Session"   text,
  "Total Kcal"    numeric default 0,
  "Total Protein" numeric default 0,
  "Total Carbs"   numeric default 0,
  "Total Fat"     numeric default 0,
  "Items Logged"  text
);

-- ---------------------------------------------------------------------------
-- Saved meal combos. 'Items' is likewise a JSON string.
-- ---------------------------------------------------------------------------
create table if not exists public.macro_tracker_favorites (
  id      uuid primary key default gen_random_uuid(),
  "Name"  text not null,
  "Items" text
);

-- ---------------------------------------------------------------------------
-- Weight log. bf (body fat %) stays null when not entered - the app tells
-- "not measured" apart from zero.
-- ---------------------------------------------------------------------------
create table if not exists public.macro_weight_tracker (
  id     uuid primary key default gen_random_uuid(),
  date   date not null,
  weight numeric not null,
  bf     numeric
);

-- ---------------------------------------------------------------------------
-- Access.
--
-- The app connects with the public publishable key, then signs in with email
-- and password. So access goes to the `authenticated` role only, and the
-- publishable key on its own - which anyone can read out of the deployed
-- config.js - opens nothing.
--
-- There is no per-user filtering because this project holds exactly one
-- person's data. That only stays true if nobody else can sign up: turn OFF
-- "Allow new users to sign up" in Authentication settings once her account
-- exists. With sign-ups left on, a stranger could create an account and these
-- policies would give them her whole database.
--
-- The grants are explicit so this works whether or not the project hands table
-- privileges to the API roles by default. Where it already does, they change
-- nothing.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'macro_targets', 'macro_food_database', 'macro_daily_logs',
    'macro_tracker_favorites', 'macro_weight_tracker'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_authenticated', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime. app.js subscribes to changes on all five tables, which is how a
-- meal logged on the PC shows up on the phone within seconds.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'macro_targets', 'macro_food_database', 'macro_daily_logs',
    'macro_tracker_favorites', 'macro_weight_tracker'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The single targets row. It has to exist - the app updates it and never
-- creates it - but the numbers don't matter: she sets her own in the app.
-- ---------------------------------------------------------------------------
insert into public.macro_targets (kcal, protein, carbs, fat)
select 2000, 180, 200, 55
where not exists (select 1 from public.macro_targets);
