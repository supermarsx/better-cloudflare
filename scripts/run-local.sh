#!/usr/bin/env bash
# Minimal script to run the server and frontend locally in the same process
set -euo pipefail
echo "Installing dependencies..."
npm install --legacy-peer-deps
echo "Starting server+dev..."
npm run dev:server
