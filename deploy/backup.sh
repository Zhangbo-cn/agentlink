#!/bin/sh
# Online, consistent backup of the SQLite database (safe while the server runs).
# Usage: deploy/backup.sh /var/lib/agentlink /backups
set -eu
DATA=${1:?data dir}; OUT=${2:?backup dir}
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$DATA/agentlink.db" "$OUT/agentlink-$STAMP.db"
tar -C "$DATA" -czf "$OUT/blobs-$STAMP.tgz" blobs
echo "$OUT/agentlink-$STAMP.db"
