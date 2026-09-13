@echo off
set CONF=%APPDATA%\Aether\config.json
if not "%AETHER_CONFIG%"=="" set CONF=%AETHER_CONFIG%
if not exist "%CONF%" (
  echo config yok: %CONF%
  echo Aether panel - Atolye - sing-box.json dosyasini buraya koy.
  exit /b 1
)
"%~dp0aether-core.exe" run -c "%CONF%"
