#!/bin/bash
# Run Complement tests against this homeserver
#
# Usage:
#   ./scripts/complement.sh                    # run all tests
#   ./scripts/complement.sh -run TestRegister  # run specific test
#   ./scripts/complement.sh -count 1 -v        # verbose, no caching
#
# Prerequisites:
#   - Docker installed
#   - Go installed
#   - Complement cloned to ../complement or set COMPLEMENT_DIR

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPLEMENT_DIR="${COMPLEMENT_DIR:-/tmp/complement}"

if [ ! -d "$COMPLEMENT_DIR" ]; then
    echo "Complement not found at $COMPLEMENT_DIR"
    echo "Clone it: git clone https://github.com/matrix-org/complement.git $COMPLEMENT_DIR"
    exit 1
fi

IMAGE_NAME="complement-matrix-server-node"

echo "Building Complement Docker image..."
docker build -t "$IMAGE_NAME" -f "$PROJECT_DIR/Dockerfile.complement" "$PROJECT_DIR"

echo "Running Complement tests..."
cd "$COMPLEMENT_DIR"

COMPLEMENT_BASE_IMAGE="$IMAGE_NAME" \
COMPLEMENT_DEBUG="${COMPLEMENT_DEBUG:-0}" \
COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS="${COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS:-0}" \
    go test -timeout 300s "$@" ./tests/...
