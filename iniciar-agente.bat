@echo off
title Agente Ghost App - Telemetria USB Coquimbo
echo ========================================================
echo   Iniciando Agente de Telemetria de Token USB (Local)
echo   Ilustre Municipalidad de Coquimbo
echo ========================================================
echo.
cd /d "%~dp0ghost-app" 2>nul || cd /d "%~dp0"
node main.js
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Hubo un problema al iniciar el agente.
  pause
)
