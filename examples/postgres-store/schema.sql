-- The crypto-aio reference store for PostgreSQL (13 or later; tested on 16).
--
-- `migrate()` runs this file in one transaction, with `search_path` set to the store's
-- schema, so every name here is unqualified. Every statement is `IF NOT EXISTS`, so
-- running it again changes nothing. Read README.md for the design.
--
-- Nested values (an intent, an unsigned transaction, an ordering, an Attempt, an
-- observation) are `text` holding `stringifyTagged` JSON, which keeps bigints and bytes
-- exact. Not `jsonb`: it reorders keys and refuses a `\u0000` escape, which a memo can
-- carry. Nothing here queries inside them; the fields the store filters, orders or checks
-- on are columns of their own.
--
-- Times are JavaScript numbers (milliseconds) from the store's clock, kept as
-- `double precision`, which holds every finite JavaScript number exactly.

-- One row per Operation. Its Attempts are rows of `attempts`.
CREATE TABLE IF NOT EXISTS operations (
  namespace          text             NOT NULL,
  id                 text             NOT NULL,
  -- The order rows were inserted in: it breaks a tie between equal `created_at` values,
  -- as the memory store's insertion order does.
  seq                bigint           GENERATED ALWAYS AS IDENTITY,
  -- The record format (OPERATION_FORMAT when the record was created). Written once and
  -- never updated; NULL for a record of 0.1.0, which has none (format 1).
  format             integer,
  idempotency_key    text             NOT NULL,
  intent_hash        text             NOT NULL,
  kind               text             NOT NULL,
  state              text             NOT NULL,
  -- context.chain, context.network and intent.from, copied out for `list` filters.
  chain              text,
  network            text,
  from_address       text,
  context            text             NOT NULL,
  intent             text             NOT NULL,
  -- The patchable fields. NULL is an absent field: `clear` writes NULL, and a read leaves
  -- the key out. No field of an OperationRecord can hold null itself.
  outcome            text,
  unsigned           text,
  reservation        text,
  signer_tickets     text,
  partial_signatures text,
  active_attempt_id  text,
  ambiguous          boolean,
  error              text,
  next_check_at      double precision,
  -- Store-owned: the compare-and-set version and the worker claim.
  version            bigint           NOT NULL,
  claim_worker       text,
  claim_token        bigint,
  claim_until        double precision,
  created_at         double precision NOT NULL,
  updated_at         double precision NOT NULL,
  -- Top-level keys this schema has no column for (a field of a newer record format), as
  -- one tagged JSON object, so a record never loses a field it was created with.
  extra              text,
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, idempotency_key)
);

-- claimDue: the due, unfinished Operations of a namespace, in (nextCheckAt, createdAt)
-- order. Partial, so finished Operations, however many accumulate, are never scanned.
-- The state list is TERMINAL_STATES; operations.ts writes the same list in its query, and
-- the planner uses this index only when the two match.
CREATE INDEX IF NOT EXISTS operations_due
  ON operations (namespace, next_check_at, created_at, seq)
  WHERE next_check_at IS NOT NULL
    AND state NOT IN ('final', 'failed', 'expired', 'abandoned');

-- list and purge: a namespace's Operations in creation order.
CREATE INDEX IF NOT EXISTS operations_created ON operations (namespace, created_at, seq);

-- Claim tokens: strictly increasing per store. A sequence never hands out a value twice,
-- even when the transaction that drew it rolls back.
CREATE SEQUENCE IF NOT EXISTS claim_tokens AS bigint;

-- One row per Attempt, inserted by appendAttempt and never updated: an Attempt is
-- immutable once stored.
CREATE TABLE IF NOT EXISTS attempts (
  namespace    text    NOT NULL,
  operation_id text    NOT NULL,
  -- The Attempt's index in OperationRecord.attempts.
  position     integer NOT NULL,
  id           text    NOT NULL,
  -- ref.id, copied out for findByRef.
  ref_id       text,
  -- The whole AttemptRecord.
  record       text    NOT NULL,
  PRIMARY KEY (namespace, operation_id, position),
  UNIQUE (namespace, operation_id, id),
  FOREIGN KEY (namespace, operation_id)
    REFERENCES operations (namespace, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS attempts_ref ON attempts (namespace, ref_id);
-- Not UNIQUE: the port says Attempt ids are globally unique, and the core makes them so,
-- but the contract suite gives Attempts of different Operations the same id (see
-- README.md). Observations, keyed by Attempt id alone, rely on the core's random ids.
CREATE INDEX IF NOT EXISTS attempts_id ON attempts (id);

-- Each Attempt's latest observation, keyed by Attempt id alone, as the port keys it.
-- `putObservation` replaces `record` whole.
CREATE TABLE IF NOT EXISTS observations (
  attempt_id   text   PRIMARY KEY,
  operation_id text   NOT NULL,
  -- txHash, copied out for findByRef.
  tx_hash      text,
  -- The whole observation but its version.
  record       text   NOT NULL,
  version      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS observations_tx_hash ON observations (tx_hash)
  WHERE tx_hash IS NOT NULL;

-- Leases. A row outlives its lease: release clears the owner but keeps the row, so the
-- key's next token continues from the last one instead of starting again at 1.
CREATE TABLE IF NOT EXISTS leases (
  key        text             PRIMARY KEY,
  owner      text,
  token      bigint           NOT NULL,
  expires_at double precision NOT NULL
);

-- Nonce state per address. `numeric`, not `bigint`: an EVM nonce is a u64, past bigint's
-- signed 64-bit range.
CREATE TABLE IF NOT EXISTS sequences (
  key      text      PRIMARY KEY,
  next     numeric   NOT NULL,
  released numeric[] NOT NULL,
  fence    numeric   NOT NULL,
  version  bigint    NOT NULL
);

-- Scanner positions.
CREATE TABLE IF NOT EXISTS cursors (
  key     text   PRIMARY KEY,
  cursor  text   NOT NULL,
  version bigint NOT NULL
);
