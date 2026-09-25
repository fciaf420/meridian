#!/bin/bash
set -e

echo "Installing Meridian DLMM Agent..."

# Check if nuggets exists alongside meridian
if [ ! -d "../nuggets" ]; then
  echo "Cloning nuggets (holographic memory)..."
  git clone https://github.com/NeoVertex1/nuggets.git ../nuggets
fi

# Build nuggets
echo "Building nuggets..."
cd ../nuggets
npm install
npm run build
cd - > /dev/null

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
