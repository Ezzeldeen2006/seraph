@echo off
rem Builds Seraph's Skua engine host for Windows (app\engine\win-x64) and Linux (app\engine\linux-x64).
rem First: node engine\sync-skua.js  (engine\vendor = Skua.Core from engine\skua-src + Seraph's patches).
cd /d %~dp0
if not exist vendor\Skua.Core (echo engine\vendor is missing - run: node engine\sync-skua.js & exit /b 1)
dotnet publish host\SeraphSkua.Host.csproj -c Release -r win-x64 --self-contained false -o bin\win-x64 -v q -clp:NoSummary || goto :fail
dotnet publish host\SeraphSkua.Host.csproj -c Release -r linux-x64 --self-contained false -o bin\linux-x64 -v q -clp:NoSummary || goto :fail
if exist ..\app\engine rmdir /s /q ..\app\engine
xcopy /e /i /q bin\win-x64 ..\app\engine\win-x64 >nul
xcopy /e /i /q bin\linux-x64 ..\app\engine\linux-x64 >nul
del /q ..\app\engine\win-x64\*.xml ..\app\engine\linux-x64\*.xml 2>nul
echo Engine built: app\engine
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
