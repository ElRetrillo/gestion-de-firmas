@echo off
setlocal
title Desinstalador de Inicio Automatico - Ghost App Coquimbo

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\GhostAppCoquimbo.lnk"

echo ==============================================================================
echo   Desinstalando Inicio Automatico del Agente Ghost App
echo ==============================================================================
echo.

if exist "%SHORTCUT_PATH%" (
  del /f /q "%SHORTCUT_PATH%"
  echo [EXITO] Acceso directo eliminado de Inicio de Windows.
) else (
  echo [INFO] El agente no estaba registrado en la carpeta de Inicio de este usuario.
)

echo.
pause
