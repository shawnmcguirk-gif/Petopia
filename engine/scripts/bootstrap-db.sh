#!/usr/bin/env bash
# One-time creation of the Petopia database, its test database and the petopia_app role (D1 spec sec 2, sec 12.3, A1).
# Copied from Vitalis engine/scripts/setup-db.sh with Petopia names (Epicure calls the same script bootstrap-db.sh).
# Run through the Axiom runner on the iMac. Idempotent: an existing role/database is left alone and its password is
# NOT changed. A new role gets a random password written only to engine/.env (gitignored, mode 600) -- never printed,
# never committed. Then 001 + 002 run as the cluster admin on both databases; migrate.sh applies the rest.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
SU=(docker exec -i postgres psql -U "${PETOPIA_BOOTSTRAP_USER:-shawn}" -v ON_ERROR_STOP=1 -q)
if [[ -z "$("${SU[@]}" -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname = 'petopia_app'")" ]]; then
  [[ ! -f .env ]] || { echo "refusing: engine/.env exists but role petopia_app does not -- check by hand"; exit 1; }
  PW=$(openssl rand -hex 24)
  "${SU[@]}" -d postgres -c "CREATE ROLE petopia_app LOGIN PASSWORD '$PW' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
  umask 077
  cat > .env <<ENV
# Written by scripts/bootstrap-db.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Gitignored -- never commit.
PETOPIA_DATABASE_URL=postgresql://petopia_app:$PW@localhost:5432/petopia
PETOPIA_TEST_DATABASE_URL=postgresql://petopia_app:$PW@localhost:5432/petopia_test
PORT=4400
# Synapse member names given household access on first sign-in (sec 7.1). Edit before install-launchagent.sh.
PETOPIA_ADMINS=Ryan
ENV
  echo "created role petopia_app; credentials written to engine/.env"
else
  echo "role petopia_app already exists (password unchanged)"
fi
for db in petopia petopia_test; do
  if [[ -z "$("${SU[@]}" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]]; then
    "${SU[@]}" -d postgres -c "CREATE DATABASE $db OWNER petopia_app"
    echo "created database $db"
  fi
  "${SU[@]}" -d "$db" < ../migrations/001_init.sql
  "${SU[@]}" -d "$db" < ../migrations/002_role_hardening.sql
  echo "$db: 001 + 002 applied as admin"
done
