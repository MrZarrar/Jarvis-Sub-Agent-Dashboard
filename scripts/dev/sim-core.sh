#!/usr/bin/env bash
# Dev helper: drive the Dashboard core's live state (working-agent count,
# errors, sessions) by editing demo rows in the dashboard SQLite DB, WITHOUT
# running real Claude agents. The dashboard picks changes up on its 10s poll,
# or immediately if you hit Refresh.
#
# Usage:
#   scripts/dev/sim-core.sh working [N]   # N agents working (default 4) -> core spins up
#   scripts/dev/sim-core.sh errors  [N]   # mark N agents errored
#   scripts/dev/sim-core.sh idle          # everyone completed -> core calms
#
# Reseed first if there are no demo rows:  npm run seed
# Point at a non-default sandbox with:     CLAUDE_HOME=/path scripts/dev/sim-core.sh ...
set -euo pipefail

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
DB="$CLAUDE_HOME/agent-dashboard/dashboard.db"
[ -f "$DB" ] || { echo "No DB at $DB - start the server once (and 'npm run seed') first."; exit 1; }

NOW="$(python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
CMD="${1:-working}"
N="${2:-4}"

case "$CMD" in
  working)
    sqlite3 "$DB" "
      UPDATE sessions SET status='active', updated_at='$NOW', ended_at=NULL WHERE id LIKE 'demo-%';
      UPDATE agents  SET status='waiting', updated_at='$NOW', ended_at=NULL WHERE session_id LIKE 'demo-%';
      UPDATE agents  SET status='working', updated_at='$NOW'
        WHERE id IN (SELECT id FROM agents WHERE session_id LIKE 'demo-%' ORDER BY type='main' DESC LIMIT $N);
    "
    echo "→ $N agent(s) working. Core should spin up (Refresh or wait ~10s)." ;;
  errors)
    sqlite3 "$DB" "
      UPDATE agents SET status='error', updated_at='$NOW'
        WHERE id IN (SELECT id FROM agents WHERE session_id LIKE 'demo-%' LIMIT $N);
    "
    echo "→ $N agent(s) errored." ;;
  idle)
    sqlite3 "$DB" "UPDATE agents SET status='completed', updated_at='$NOW' WHERE session_id LIKE 'demo-%';"
    echo "→ all demo agents idle. Core calms." ;;
  *)
    echo "Unknown command '$CMD'. Use: working [N] | errors [N] | idle"; exit 1 ;;
esac
sqlite3 "$DB" "SELECT status, count(*) FROM agents WHERE session_id LIKE 'demo-%' GROUP BY status;" | sed 's/^/   /'
