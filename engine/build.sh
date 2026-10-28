#!/usr/bin/env bash
# Builds Seraph's Skua engine host for Linux into app/engine/linux-x64.
# First: node engine/sync-skua.js (engine/vendor = Skua.Core from engine/skua-src + Seraph's patches).
set -euo pipefail
cd "$(dirname "$0")"
[ -d vendor/Skua.Core ] || { echo "engine/vendor is missing - run: node engine/sync-skua.js"; exit 1; }
dotnet publish host/SeraphSkua.Host.csproj -c Release -r linux-x64 --self-contained false -o bin/linux-x64 -v q -clp:NoSummary
rm -rf ../app/engine/linux-x64 && mkdir -p ../app/engine
cp -r bin/linux-x64 ../app/engine/linux-x64
rm -f ../app/engine/linux-x64/*.xml
echo "Engine built: app/engine/linux-x64"
