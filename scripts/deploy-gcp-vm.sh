#!/bin/bash
# ==============================================================================
# SCRIPT DE INSTALACIÓN RÁPIDA EN GOOGLE COMPUTE ENGINE (UBUNTU / DEBIAN)
# Optimizado para VMs de bajos recursos (GCP e2-micro / e2-small / e2-medium)
# Sistema de Gestión de Firmas y Telemetría - I. Municipalidad de Coquimbo
# ==============================================================================
set -e

echo "=== [1/6] Actualizando repositorios del sistema ==="
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
    sudo usermod -aG docker $USER
    echo "Docker instalado correctamente."
else
    echo "Docker ya se encuentra instalado."
fi

echo "=== [3/6] Configurando Swap y optimización de memoria (Crítico para VMs de bajos recursos) ==="
if [ $(free -m | awk '/^Swap:/ {print $2}') -eq 0 ]; then
    echo "Creando archivo Swap de 2GB para garantizar estabilidad en builds y picos de memoria..."
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    # Ajuste de swappiness a 20 para priorizar RAM física
    sudo sysctl vm.swappiness=20
    echo 'vm.swappiness=20' | sudo tee -a /etc/sysctl.conf
fi

echo "=== [4/6] Configurando Firewall UFW (SSH, HTTP, HTTPS) ==="
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw --force enable || true

echo "=== [5/6] Instalando Tarea Cron de Respaldo Automatizado ==="
BACKUP_SCRIPT_PATH="$(pwd)/scripts/backup.sh"
chmod +x "$BACKUP_SCRIPT_PATH"

# Programar ejecución diaria a las 02:00 AM (Horario Valle / Menor consumo de recursos)
CRON_JOB="0 2 * * * $BACKUP_SCRIPT_PATH >> $(pwd)/backups/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -F -v "$BACKUP_SCRIPT_PATH" ; echo "$CRON_JOB") | crontab -
echo "Cron de respaldo diario a las 02:00 AM configurado exitosamente."

echo "=== [6/6] Preparación completa ==="
echo "La VM de Google Cloud Platform está lista con optimización de recursos."
echo "Para desplegar los servicios:"
echo "  docker compose up -d --build"
