-- =============================================================
-- Petopia DB -- 005: media (D1 spec sec 2 "Photos", 3.7; A8).
-- A row per stored photo. The file itself lives in <vault>/_petopia-media/<sha256>.jpg, already decoded,
-- re-encoded (max 1600 px JPEG) and stripped of all metadata incl. GPS by engine/src/photos.ts before it is
-- written; the database only records the hash and size. Non-clinical, so soft-closed with retired_at.
-- FORCE RLS, fail-closed. Idempotent.
-- =============================================================
CREATE TABLE IF NOT EXISTS media.item (
  media_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES core.workspace(workspace_id),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  path          text NOT NULL CHECK (path = '_petopia-media/' || sha256 || '.jpg'),
  width         integer NOT NULL CHECK (width > 0 AND width <= 1600),
  height        integer NOT NULL CHECK (height > 0 AND height <= 1600),
  taken_on      date NULL,
  added_by      text NOT NULL,
  retired_at    timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_item_ws_id UNIQUE (workspace_id, media_item_id),
  CONSTRAINT media_item_ws_sha UNIQUE (workspace_id, sha256)
);
ALTER TABLE media.item ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON media.item;
CREATE POLICY workspace_isolation ON media.item
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint);
