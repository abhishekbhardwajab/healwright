-- PostgreSQL schema for the production persistence adapter.
-- The PoC uses JsonFileStore behind the same Store interface (src/store/Store.ts).
-- Every tenant-owned row carries tenant_id; row-level security enforces isolation.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE test_suites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL
);

CREATE TABLE test_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id    uuid REFERENCES test_suites(id) ON DELETE SET NULL,
  name        text NOT NULL,
  start_url   text,
  viewport    jsonb NOT NULL DEFAULT '{"width":1280,"height":800}',
  variables   jsonb NOT NULL DEFAULT '{}',          -- non-secret test data only
  version     int  NOT NULL DEFAULT 1,              -- optimistic locking for concurrent editors
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Secrets are stored encrypted (envelope encryption, KMS-held key), never in actions or logs.
CREATE TABLE test_secrets (
  test_id     uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,                        -- e.g. TEST_PASSWORD
  ciphertext  bytea NOT NULL,
  key_id      text NOT NULL,
  PRIMARY KEY (test_id, name)
);

CREATE TABLE recording_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_id     uuid REFERENCES test_cases(id) ON DELETE SET NULL,
  worker_id   text,                                 -- which browser worker hosts it
  status      text NOT NULL CHECK (status IN ('recording','paused','stopped','expired')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);

-- One row per step; the full normalized Action (see src/model/actions.ts) is kept as jsonb
-- so the model can evolve without migrations, with the hot fields promoted to columns.
CREATE TABLE recorded_actions (
  id          text NOT NULL,
  test_id     uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position    int  NOT NULL,
  type        text NOT NULL,
  name        text,
  disabled    boolean NOT NULL DEFAULT false,
  action      jsonb NOT NULL,                       -- target, selectors[], signals, value…
  screenshot_id uuid,
  PRIMARY KEY (test_id, id),
  UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED   -- reorder in one transaction
);

CREATE TABLE test_executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_id     uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  test_version int NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued','running','passed','failed','stopped')),
  browser     text NOT NULL DEFAULT 'chromium',
  options     jsonb NOT NULL,
  triggered_by text NOT NULL DEFAULT 'manual',      -- manual | schedule | api
  started_at  timestamptz,
  finished_at timestamptz
);

CREATE TABLE execution_steps (
  execution_id uuid NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step_index   int  NOT NULL,
  action_id    text NOT NULL,
  status       text NOT NULL,
  duration_ms  int,
  attempts     int,
  healed       boolean NOT NULL DEFAULT false,
  used_selector jsonb,
  error        text,                                -- secret-masked before insert
  screenshot_id uuid,
  PRIMARY KEY (execution_id, step_index)
);

CREATE TABLE screenshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key text NOT NULL,                        -- object storage (S3/GCS), not the DB
  kind        text NOT NULL CHECK (kind IN ('record','step','failure','baseline')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE execution_logs (
  id           bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL,
  level        text NOT NULL,
  message      text NOT NULL                         -- secret-masked before insert
);

CREATE INDEX ON test_cases (tenant_id, project_id);
CREATE INDEX ON test_executions (tenant_id, test_id, started_at DESC);
CREATE INDEX ON execution_logs (execution_id, ts);

-- Tenant isolation
ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_cases USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- (repeat for every tenant-owned table)
