#!/bin/bash
set -e

# Complement sets SERVER_NAME to the homeserver name (e.g. "hs1")
# It also mounts CA cert at /complement/ca/ca.crt and key at /complement/ca/ca.key

SERVER_NAME="${SERVER_NAME:-localhost}"
PORT="${PORT:-8008}"
FED_PORT="${FED_PORT:-8448}"

echo "Starting matrix-server-node for Complement"
echo "  SERVER_NAME=$SERVER_NAME"
echo "  Client API: :$PORT (HTTP)"
echo "  Federation: :$FED_PORT (HTTPS)"

# Generate server TLS cert signed by Complement's CA for federation
CA_CERT="/complement/ca/ca.crt"
CA_KEY="/complement/ca/ca.key"
SERVER_CERT="/tmp/server.crt"
SERVER_KEY="/tmp/server.key"

if [ -f "$CA_CERT" ] && [ -f "$CA_KEY" ]; then
    echo "Generating server TLS cert from Complement CA..."

    # Generate server private key
    openssl genrsa -out "$SERVER_KEY" 2048 2>/dev/null

    # Generate CSR with SAN for the server name
    openssl req -new -key "$SERVER_KEY" -out /tmp/server.csr \
        -subj "/CN=$SERVER_NAME" 2>/dev/null

    # Sign with CA - include SAN for both DNS name and IP
    cat > /tmp/server.ext << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,nonRepudiation,keyEncipherment
subjectAltName=DNS:$SERVER_NAME,IP:127.0.0.1
EOF

    openssl x509 -req -in /tmp/server.csr \
        -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
        -out "$SERVER_CERT" -days 1 \
        -extfile /tmp/server.ext 2>/dev/null

    echo "TLS cert generated for $SERVER_NAME"

    export TLS_CERT="$SERVER_CERT"
    export TLS_KEY="$SERVER_KEY"
    export FED_PORT="$FED_PORT"
else
    echo "No Complement CA found, running without federation TLS"
fi

# Export for the Node.js server
export SERVER_NAME
export PORT
export STORAGE=sqlite
export DATABASE_PATH=/tmp/matrix.db
export DISABLE_RATE_LIMIT=1

# Start the server
exec node src/index.ts
