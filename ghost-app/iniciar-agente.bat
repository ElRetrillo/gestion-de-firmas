@echo off
setlocal
title Agente Ghost App - Telemetria USB Coquimbo

:: Resolver directorio actual del script de forma 100% portable
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

echo ========================================================
echo   Iniciando Agente Silencioso Ghost App (USB Telemetria)
echo   Ilustre Municipalidad de Coquimbo
echo   Directorio: %APP_DIR%
echo ========================================================
echo.

:: Verificar si Node.js esta disponible en el PATH
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Node.js no fue encontrado en el sistema.
  echo Por favor instale Node.js LTS para ejecutar el agente.
  pause
  exit /b 1
)

node main.js
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] El agente se detuvo con codigo de error %errorlevel%.
  pause
)
