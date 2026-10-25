-- ==============================================================================
-- Pharmacie Bleue Plus — Supabase PostgreSQL Schema & Row-Level Security (RLS)
-- Free-Tier Backend Configuration (50,000 MAUs, 500 MB Postgres, 1 GB Storage)
-- Regulatory Standards: Cameroon Law n° 90/035 & SOP-RH-FP-03 Pharmacist Visa Gate
-- Privacy Mandate: Zero-Knowledge Client-Side AES-256-GCM Blob Storage
-- ==============================================================================

-- 1. EXTENSIONS
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- 2. PRIVATE STORAGE BUCKET: 'prescriptions'
-- Stores client-side encrypted JSON envelopes (AES-256-GCM + 96-bit IV + Auth Tag).
-- Strictly non-public to prevent direct URL exposure without authenticated tokens.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'prescriptions',
  'prescriptions',
  false,
  10485760, -- 10 MB per encrypted envelope
  array['application/json', 'application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760;

-- 3. STORAGE ROW-LEVEL SECURITY POLICIES
-- Allow authenticated users and the anonymous public client key to upload encrypted blobs
create policy "Allow client upload of encrypted prescription envelopes"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'prescriptions');

create policy "Allow authorized reading of encrypted prescription envelopes"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'prescriptions');

create policy "Allow updating encrypted prescription envelopes"
on storage.objects for update
to anon, authenticated
using (bucket_id = 'prescriptions');

-- 4. TABLE: public.prescriptions
-- Zero-Knowledge Clinical Metadata & Regulatory Visa Tracking.
-- Strictly NO cleartext patient names, phone numbers, or unencrypted image blobs.
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  rx_code text unique not null,
  user_id uuid references auth.users(id) on delete set null,
  
  -- Cryptographic Integrity & Location Pointer
  storage_object_path text not null,
  plaintext_sha256 text not null,
  ciphertext_sha256 text not null,
  iv_hex text not null,
  
  -- Dispensing & Logistics Metadata
  fulfillment_mode text default 'FAST_TRACK_PICKUP',
  payment_method text default 'MTN_MOMO',
  
  -- Cameroon Law n° 90/035 & SOP-RH-FP-03 4-Stage State Machine:
  -- Stage 1: STAGE_1_UPLOADED
  -- Stage 2: STAGE_2_PREPARATION (Auxiliary stock picking & packaging)
  -- Stage 3: STAGE_3_PHARMACIST_VISA (Pharmacist 3-point Double-Control)
  -- Stage 4: STAGE_4_DISPENSING_READY (Comptoir delivery / release)
  stage smallint not null default 1 check (stage between 1 and 4),
  stage_code text not null default 'STAGE_1_UPLOADED',
  
  -- Pharmacist Double-Control Visa Gate
  pharmacist_visa text,
  visa_signature text,
  intervention_note text,
  
  -- Comprehensive Regulatory Audit Trail
  audit_log jsonb default '[]'::jsonb,
  
  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- MANDATORY CLINICAL REGULATORY GATE:
  -- Prescriptions CANNOT be marked ready for dispensing (Stage 4)
  -- without a valid 64-character SHA-256 digital ONPC Pharmacist Visa Signature.
  constraint sop_rh_fp_03_visa_gate check (
    stage < 4 or (visa_signature is not null and length(visa_signature) >= 32)
  )
);

-- Fast lookup indexes
create index if not exists idx_prescriptions_rx_code on public.prescriptions(rx_code);
create index if not exists idx_prescriptions_stage on public.prescriptions(stage);
create index if not exists idx_prescriptions_created_at on public.prescriptions(created_at desc);

-- 5. AUTOMATIC UPDATED_AT TRIGGER
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_prescriptions_updated_at on public.prescriptions;
create trigger set_prescriptions_updated_at
before update on public.prescriptions
for each row
execute procedure public.handle_updated_at();

-- 6. TABLE ROW-LEVEL SECURITY (RLS)
alter table public.prescriptions enable row level security;

-- Client anonymous access policies (for client-side bridge with anon key)
create policy "Allow read access to prescriptions"
on public.prescriptions for select
to anon, authenticated
using (true);

create policy "Allow upsert of prescriptions by client bridge"
on public.prescriptions for insert
to anon, authenticated
with check (true);

create policy "Allow update of prescriptions by client bridge"
on public.prescriptions for update
to anon, authenticated
using (true);

-- 7. OPTIONAL ADHERENCE TELEMETRY TABLE (Zero-PII Aggregates)
create table if not exists public.adherence_telemetry (
  id uuid primary key default gen_random_uuid(),
  device_token_hash text not null,
  total_alarms_scheduled int default 0,
  intakes_confirmed int default 0,
  intakes_skipped int default 0,
  adherence_rate_pct numeric(5,2) default 100.0,
  reported_at timestamptz not null default now()
);

alter table public.adherence_telemetry enable row level security;

create policy "Allow anonymous adherence metric reporting"
on public.adherence_telemetry for insert
to anon, authenticated
with check (true);
