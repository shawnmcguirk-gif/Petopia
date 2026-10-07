#!/usr/bin/env bash
# Petopia migration runner (D1 spec sec 2, A2) -- Vitalis's migrate.sh with Petopia names.
# Applies migrations/*.sql in filename order, once each, recording them in public.schema_migrations, then (for the
# live database only) regenerates schema.sql. Runs on the iMac (needs the `postgres` container).
#   ./engine/scripts/migrate.sh                           # live `petopia`: apply pending, refresh schema.sql
#   PETOPIA_DB=petopia_test ./engine/scripts/migrate.sh   # the test database
#   ./engine/scripts/migrate.sh --status                  # list applied/pending only
# 001 and 002 are run first as the cluster admin by bootstrap-db.sh; they are idempotent, so re-running them here
# as petopia_app (the database owner) is harmless.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
DB="${PETOPIA_DB:-petopia}"
USER_="${PETOPIA_MIGRATE_USER:-petopia_app}"
PSQL=(docker exec -i postgres psql -U "$USER_" -d "$DB" -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
applied=$("${PSQL[@]}" -Atc "SELECT filename FROM public.schema_migrations")
for f in migrations/*.sql; do
  b=$(basename "$f")
  if grep -qx "$b" <<<"$applied"; then echo "applied  $b"; continue; fi
  if [[ "${1:-}" == "--status" ]]; then echo "PENDING  $b"; continue; fi
  echo "applying $b"
  "${PSQL[@]}" < "$f"
  "${PSQL[@]}" -c "INSERT INTO public.schema_migrations (filename) VALUES ('$b')"
done
if [[ "${1:-}" != "--status" && "$DB" == "petopia" ]]; then
  docker exec postgres pg_dump -U "$USER_" -d "$DB" --schema-only --no-owner --no-privileges -n core -n ref -n animal -n media -n ingest > schema.sql
  echo "schema.sql refreshed ($(wc -l < schema.sql) lines)"
fi
