#!/bin/bash
# Aprovisionamiento inicial de VM Linux (Ubuntu/Debian) para Monitoreo y Telemetría de Tokens USB
set -e

echo "=== [1/6] Actualizando paquetes del sistema ==="
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release git ufw cron certbot

echo "=== [2/6] Instalando Docker Engine y Docker Compose Plugin ==="
if ! command -v docker &> /dev/null; then
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker "$USER"
fi

echo "=== [3/6] Configurando Swap (2GB) para estabilidad en VMs compactas ==="
if [ "$(free -m | awk '/^Swap:/ {print $2}')" -eq 0 ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    sudo sysctl vm.swappiness=20
    echo 'vm.swappiness=20' | sudo tee -a /etc/sysctl.conf
fi

echo "=== [4/6] Configurando Firewall UFW (SSH, HTTP, HTTPS) ==="
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw --force enable || true

echo "=== [5/6] Instalando tarea cron de respaldo diario de PostgreSQL ==="
BACKUP_SCRIPT_PATH="$(pwd)/scripts/backup.sh"
chmod +x "$BACKUP_SCRIPT_PATH"
mkdir -p "$(pwd)/backups"
CRON_JOB="0 2 * * * $BACKUP_SCRIPT_PATH >> $(pwd)/backups/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -F -v "$BACKUP_SCRIPT_PATH" ; echo "$CRON_JOB") | crontab -

echo "=== [6/6] VM lista ==="
echo "Pasos siguientes:"
echo "  1. cp .env.example .env && nano .env"
echo "  2. Configurar certificados TLS en docker/nginx/ssl/server.crt y server.key"
echo "  3. docker compose up -d --build"
