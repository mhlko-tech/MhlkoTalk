#!/usr/bin/env bash
set -euo pipefail

install_dir=/opt/mirotalksfu
public_ip=129.159.223.64
public_host=129-159-223-64.sslip.io
worker_origin=https://mhtalk-token-service.mhlkotalk.workers.dev

cd "$install_dir"
umask 077

if [[ ! -f .env ]]; then
  cp .env.template .env
  api_secret="$(openssl rand -hex 32)"
  jwt_secret="$(openssl rand -hex 48)"
  host_password="$(openssl rand -hex 24)"

  sed -i \
    -e 's|^NODE_ENV=.*|NODE_ENV=production|' \
    -e "s|^SFU_ANNOUNCED_IP=.*|SFU_ANNOUNCED_IP=${public_ip}|" \
    -e 's|^SFU_LISTEN_IP=.*|SFU_LISTEN_IP=0.0.0.0|' \
    -e 's|^SFU_MIN_PORT=.*|SFU_MIN_PORT=40000|' \
    -e 's|^SFU_MAX_PORT=.*|SFU_MAX_PORT=40001|' \
    -e 's|^SFU_NUM_WORKERS=.*|SFU_NUM_WORKERS=2|' \
    -e 's|^SFU_SERVER=.*|SFU_SERVER=true|' \
    -e "s|^SERVER_HOST_URL=.*|SERVER_HOST_URL=https://${public_host}|" \
    -e 's|^SERVER_LISTEN_IP=.*|SERVER_LISTEN_IP=127.0.0.1|' \
    -e 's|^TRUST_PROXY=.*|TRUST_PROXY=true|' \
    -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=${worker_origin}|" \
    -e "s|^ALLOWED_EMBED_ORIGINS=.*|ALLOWED_EMBED_ORIGINS=${worker_origin}|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" \
    -e 's|^JWT_EXPIRATION=.*|JWT_EXPIRATION=2h|' \
    -e 's|^HOST_PROTECTED=.*|HOST_PROTECTED=true|' \
    -e 's|^HOST_USER_AUTH=.*|HOST_USER_AUTH=true|' \
    -e "s|^HOST_USERS=.*|HOST_USERS=\"mhtalk-worker:${host_password}:MHTalk:*\"|" \
    -e "s|^API_KEY_SECRET=.*|API_KEY_SECRET=${api_secret}|" \
    -e 's|^API_ALLOW_STATS=.*|API_ALLOW_STATS=false|' \
    -e 's|^API_ALLOW_MEETINGS=.*|API_ALLOW_MEETINGS=false|' \
    -e 's|^API_ALLOW_MEETING=.*|API_ALLOW_MEETING=false|' \
    -e 's|^API_ALLOW_MEETING_END=.*|API_ALLOW_MEETING_END=false|' \
    -e 's|^API_ALLOW_JOIN=.*|API_ALLOW_JOIN=true|' \
    -e 's|^API_ALLOW_TOKEN=.*|API_ALLOW_TOKEN=true|' \
    -e 's|^APP_NAME=.*|APP_NAME=MHTalk Calls|' \
    -e 's|^SHOW_TOP_SPONSORS=.*|SHOW_TOP_SPONSORS=false|' \
    -e 's|^SHOW_SPONSORS=.*|SHOW_SPONSORS=false|' \
    -e 's|^SHOW_PAST_SPONSORS=.*|SHOW_PAST_SPONSORS=false|' \
    -e 's|^SHOW_ADVERTISERS=.*|SHOW_ADVERTISERS=false|' \
    -e 's|^SHOW_SUPPORT_US=.*|SHOW_SUPPORT_US=false|' \
    -e 's|^STATS_ENABLED=.*|STATS_ENABLED=false|' \
    -e 's|^ROOM_MAX_PARTICIPANTS=.*|ROOM_MAX_PARTICIPANTS=50|' \
    .env
fi

sudo chown 1000:1000 .env
sudo chmod 600 .env
sudo install -o root -g root -m 0644 /tmp/mhtalk-sfu.conf /etc/nginx/sites-available/mhtalk-sfu
sudo ln -sfn /etc/nginx/sites-available/mhtalk-sfu /etc/nginx/sites-enabled/mhtalk-sfu
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

sudo docker compose pull
sudo docker compose up -d

for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:3010/ >/dev/null; then
    break
  fi
  sleep 2
done

curl --fail --silent --show-error http://127.0.0.1:3010/ >/dev/null
sudo docker compose ps
