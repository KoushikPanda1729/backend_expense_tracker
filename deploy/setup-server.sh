#!/usr/bin/env bash
# Run ONCE on a fresh Ubuntu 22.04/24.04 server (deploy.sh does this for you with --setup).
# Installs Docker, adds 2 GB of swap (so a 1-2 GB server does not run out of memory), and creates /opt/kharcha.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  # Ubuntu's own packages work on every release; the get.docker.com script lags behind new Ubuntu versions
  sudo apt-get update -y
  if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 rsync curl; then
    curl -fsSL https://get.docker.com | sudo sh
  fi
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

if ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo mkdir -p /opt/kharcha
sudo chown "$USER":"$USER" /opt/kharcha
echo "server ready"
