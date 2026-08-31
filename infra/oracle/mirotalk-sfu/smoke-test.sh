#!/usr/bin/env bash
set -euo pipefail

env_file=/opt/mirotalksfu/.env
base_url="${1:-https://129-159-223-64.sslip.io}"
api_secret="$(sudo sed -n 's/^API_KEY_SECRET=//p' "$env_file")"
host_line="$(sudo grep '^HOST_USERS=' "$env_file")"
host_password="$(printf '%s' "$host_line" | cut -d: -f2)"

body="$(printf '{"room":"mhtalk-deployment-check","name":"MHTalk Health Check","audio":false,"video":false,"screen":false,"chat":false,"notify":false,"duration":"00:05:00","token":{"username":"mhtalk-worker","password":"%s","presenter":true,"expire":"5m"}}' "$host_password")"
response="$(curl --fail --silent --show-error \
  --request POST "${base_url%/}/api/v1/join" \
  --header "authorization: $api_secret" \
  --header 'content-type: application/json' \
  --data "$body")"

RESPONSE="$response" python3 - <<'PY'
import json
import os
from urllib.parse import parse_qs, urlparse

data = json.loads(os.environ["RESPONSE"])
url = urlparse(data.get("join", ""))
print(f"join_created={str(bool(data.get('join'))).lower()}")
print(f"join_origin={url.scheme}://{url.netloc}" if url.netloc else "join_origin=missing")
print(f"signed_token={str(bool(parse_qs(url.query).get('token'))).lower()}")
PY
