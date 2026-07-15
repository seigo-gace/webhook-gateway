#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:7373}"

curl -fsS "$BASE_URL/healthz"
echo
curl -fsS "$BASE_URL/readyz"
echo
