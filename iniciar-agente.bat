@echo off
setlocal
title Agente Ghost App - Telemetria USB Coquimbo

set "ROOT_DIR=%~dp0"
set "GHOST_DIR=%ROOT_DIR%ghost-app"

if exist "%GHOST_DIR%\iniciar-agente.bat" (
  cd /d "%GHOST_DIR%"
  call "%GHOST_DIR%\iniciar-agente.bat"
) else (
  cd /d "%ROOT_DIR%"
  node main.js
)
