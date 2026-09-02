@echo off
setlocal
rem ============================================================
rem  DSH 手机端 App 构建脚本
rem  使用本机已安装的 Android SDK 与 JDK 构建 debug + release APK
rem ============================================================
cd /d "%~dp0"

set ANDROID_HOME=C:\Users\darkm\AppData\Local\Android\Sdk
if not defined JAVA_HOME set "JAVA_HOME=C:\Users\darkm\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot"

if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
  echo [错误] 未找到 Android SDK: %ANDROID_HOME%
  pause
  exit /b 1
)

set GRADLE_DIR=%~dp0tools\gradle-8.14.3
set GRADLE_CMD=%GRADLE_DIR%\bin\gradle.bat

if not exist "%GRADLE_CMD%" (
  echo [准备] 未找到 Gradle，正在下载 gradle-8.14.3-bin.zip ...
  if not exist "%~dp0tools" mkdir "%~dp0tools"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip' -OutFile '%~dp0tools\gradle.zip' -UseBasicParsing"
  powershell -NoProfile -Command "Expand-Archive -Path '%~dp0tools\gradle.zip' -DestinationPath '%~dp0tools' -Force"
  del /q "%~dp0tools\gradle.zip"
)

echo [构建] 使用 Gradle 8.14.3 构建 APK ...
call "%GRADLE_CMD%" -p "%~dp0android" --console=plain clean assembleDebug assembleRelease
if errorlevel 1 (
  echo [错误] 构建失败
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  构建完成：
echo    Debug   : %~dp0android\app\build\outputs\apk\debug\app-debug.apk
echo    Release : %~dp0android\app\build\outputs\apk\release\app-release.apk
echo  安装到已连接的设备：adb install -r ^<apk路径^>
echo ============================================================
pause
endlocal
