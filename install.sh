#!/bin/bash
set -e

echo "Installing Meridian DLMM Agent..."

# Install meridian
echo "Installing meridian..."
npm install

# Build web UI
if [ -d "web" ]; then
  echo "Building web UI..."
  cd web && npm install && npm run build && cd ..
fi

echo ""
echo "Done! Next steps:"
echo "  1. Run: node setup.js"
echo "  2. Or manually create .env with your keys"
echo "  3. Start: node index.js"
