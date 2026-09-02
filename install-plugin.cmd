@echo off
rem =====================================================================
rem  install-plugin.cmd - install the dsh_mobile_app standard plugin
rem
rem  Steps:
rem   1) copy dsh_mobile_app\ to %USERPROFILE%\.dsh\plugins\
rem   2) run npm install (ws, qrcode) if node_modules is missing
rem   3) idempotently add the plugin row to profiles\web\cordis.patch.yml
rem   4) remind the user to restart dsh web
rem
rem  Uninstall: remove the dsh_mobile_app row from cordis.patch.yml, then
rem  delete %USERPROFILE%\.dsh\plugins\dsh_mobile_app
rem =====================================================================
setlocal
set "SOURCE=%~dp0dsh_mobile_app"
set "DEST=%USERPROFILE%\.dsh\plugins\dsh_mobile_app"
set "PROFILE=%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml"

if not exist "%SOURCE%\lib\index.js" (
  echo [error] plugin source not found: %SOURCE%
  exit /b 1
)

echo == 1/4 copy plugin to %DEST%
robocopy "%SOURCE%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [error] copy failed ^(errorlevel %errorlevel%^)
  exit /b 1
)

echo == 2/4 check dependencies
if not exist "%DEST%\node_modules\ws" (
  echo      node_modules missing, running npm install...
  pushd "%DEST%"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [error] npm install failed
    popd
    exit /b 1
  )
  popd
) else (
  echo      dependencies ready
)

echo == 3/4 patch cordis.patch.yml ^(idempotent^)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dest = '%DEST%'; $f = '%PROFILE%';" ^
  "$url = 'file:///' + ($dest -replace '\\','/') + '/lib/index.js';" ^
  "$marker = 'dsh_mobile_app/lib/index.js';" ^
  "$raw = if (Test-Path $f) { Get-Content $f -Raw } else { '' };" ^
  "if ($raw -and $raw.Contains($marker)) { Write-Output '      already present, skipped' }" ^
  "else { $block = [Environment]::NewLine + [Environment]::NewLine + '- insert:' + [Environment]::NewLine + '    - id: dsh_mobile_app' + [Environment]::NewLine + \"      name: '\" + $url + \"'\" + [Environment]::NewLine + '      config:' + [Environment]::NewLine + '        port: 3081' + [Environment]::NewLine + '        host: 0.0.0.0' + [Environment]::NewLine + '        openBrowser: true' + [Environment]::NewLine; Add-Content -Path $f -Value $block -NoNewline; Write-Output '      plugin row added' }"
if errorlevel 1 (
  echo [error] failed to patch cordis.patch.yml
  exit /b 1
)

echo == 4/4 done
echo.
echo Installed. Please restart dsh web ^(tray icon / dsh-web-launcher rebuilds
echo the process^). After restart the plugin will:
echo   - open the pairing page in your browser: http://127.0.0.1:3081/pair
echo   - serve the phone on 0.0.0.0:3081 ^(LAN / Tailscale remote^)
echo Scan the QR with the Android app. Allow port 3081 in Windows Firewall
echo on first start.
echo.
endlocal
