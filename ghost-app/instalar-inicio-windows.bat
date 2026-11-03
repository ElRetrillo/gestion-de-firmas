@echo off
setlocal
title Instalador de Inicio Automatico - Ghost App Coquimbo

echo ==============================================================================
echo   Instalador de Inicio Automatico con Windows (Agente Ghost App USB)
echo   Ilustre Municipalidad de Coquimbo
echo ==============================================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "TARGET_VBS=%SCRIPT_DIR%iniciar-silencioso.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\GhostAppCoquimbo.lnk"

if not exist "%TARGET_VBS%" (
  echo [ERROR] No se encontro el archivo iniciar-silencioso.vbs en:
  echo "%TARGET_VBS%"
  pause
  exit /b 1
)

echo Creando acceso directo en la carpeta de inicio de Windows:
echo Destino: "%SHORTCUT_PATH%"
echo Apuntando a: "%TARGET_VBS%"
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = '%TARGET_VBS%'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'Agente Silencioso de Telemetria USB - Muni Coquimbo'; $s.Save()"

if %errorlevel% equ 0 (
  echo ==============================================================================
  echo [EXITO] Agente Ghost App configurado para iniciar automaticamente con Windows.
  echo No requiere privilegios de administrador y opera de forma 100%% portable.
  echo Ruta instalada: "%SHORTCUT_PATH%"
  echo ==============================================================================
) else (
  echo [ERROR] Ocurrio un problema al crear el acceso directo en Inicio.
)

echo.
pause
