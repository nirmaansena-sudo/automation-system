#!/usr/bin/env bash
# First-time setup of the Nirmaan Sena system on an Oracle Cloud (OCI) Ubuntu 24.04 VM
# (Arm "VM.Standard.A1.Flex" or AMD). Safe to run again: it never overwrites an existing .env
# or database.
#
#   git clone https://github.com/nirmaansena-sudo/automation-system.git /opt/nirmaan
#   sudo bash /opt/nirmaan/deploy/oci/setup-server.sh ops.nirmaansena.com
#
# Before running: the domain's DNS A record points to this VM's public IP, and the VCN
# security list allows TCP 80 and 443 from 0.0.0.0/0 (see deploy/oci/README.md).
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "$DOMAIN" || "$DOMAIN" == -* ]]; then
  echo "Usage: sudo bash deploy/oci/setup-server.sh ops.example.com"; exit 1
fi
if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
say() { printf '\n==> %s\n' "$*"; }

say "1/5 System updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q upgrade
apt-get install -y -q git curl openssl iptables-persistent netfilter-persistent

say "2/5 Open web ports 80 and 443 in the VM's own firewall"
# Oracle's Ubuntu images ship iptables rules that end in REJECT; new ports must be
# inserted before that rule. Done before Docker is installed so the saved rules file
# holds only these host rules (Docker adds its own at every start). Do not enable ufw.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    pos=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    if [[ -n "$pos" ]]; then iptables -I INPUT "$pos" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT; fi
  fi
done
if ! command -v docker >/dev/null; then netfilter-persistent save; fi
iptables -L INPUT -n --line-numbers | sed -n '1,12p'

say "3/5 Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker
docker compose version

say "4/5 Settings (.env)"
cd "$APP_DIR"
if [[ -f .env ]]; then
  echo ".env already exists: left unchanged."
else
  cp .env.example .env
  chmod 600 .env
  set_env() { # replace KEY=... (the line exists in .env.example)
    if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
  }
  set_env DOMAIN "$DOMAIN"
  set_env PUBLIC_URL "https://$DOMAIN"
  set_env COOKIE_SECURE true
  for key in SESSION_SECRET AUTOMATION_API_KEY N8N_SHARED_SECRET WEBSITE_FORM_SECRET; do
    set_env "$key" "$(openssl rand -hex 24)"
  done
  echo "Created .env for https://$DOMAIN with four new random secrets."
  echo "WhatsApp stays in simulator mode until you add the Meta (or 360dialog) keys: nano $APP_DIR/.env"
fi

say "5/5 Start"
docker compose up -d --build
sleep 15
docker compose ps
echo
if docker compose logs app 2>/dev/null | grep -i "setup code"; then
  echo "Open https://$DOMAIN/admin/ now and create the owner account with the setup code above."
else
  echo "No setup code shown: the owner account already exists (or the app is still starting:"
  echo "  docker compose logs app | grep -i 'setup code')"
fi
echo "Health: curl -s https://$DOMAIN/health"
