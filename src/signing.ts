import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { canonicalJson, computeContentHash, redactEvent } from "./events.ts";
import type { PDU } from "./types/events.ts";
import type { KeyId, ServerName } from "./types/index.ts";

// DER encoding prefixes for Ed25519 keys (fixed ASN.1 wrappers)
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // 16 bytes
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // 12 bytes

export interface SigningKey {
	keyId: KeyId;
	algorithm: "ed25519";
	privateKey: KeyObject;
	publicKey: KeyObject;
	publicKeyBase64: string; // Unpadded standard base64 of raw 32-byte public key
	seed: Buffer; // Raw 32-byte seed for persistence
}

// =============================================================================
// UNPADDED BASE64 HELPERS
// Matrix uses standard base64 (+ and /) but strips trailing = padding
// =============================================================================

export function unpaddedBase64(buf: Buffer): string {
	return buf.toString("base64").replace(/=+$/, "");
}

export function unpaddedBase64Decode(str: string): Buffer {
	// Re-add padding
	const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
	return Buffer.from(padded, "base64");
}

// =============================================================================
// KEY GENERATION & IMPORT
// =============================================================================

export function generateSigningKey(_serverName: string): SigningKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");

	// Extract raw 32-byte seed from PKCS8 DER
	const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
	const seed = pkcs8.subarray(PKCS8_PREFIX.length);

	// Extract raw 32-byte public key from SPKI DER
	const spki = publicKey.export({ type: "spki", format: "der" });
	const rawPub = spki.subarray(SPKI_PREFIX.length);

	// Key ID: ed25519:<first 6 chars of base64url-encoded pubkey>
	const keyTag = rawPub.toString("base64url").slice(0, 6);
	const keyId = `ed25519:${keyTag}` as KeyId;

	return {
		keyId,
		algorithm: "ed25519",
		privateKey,
		publicKey,
		publicKeyBase64: unpaddedBase64(rawPub),
		seed: Buffer.from(seed),
	};
}

export function importSigningKey(keyId: string, seed: Buffer): SigningKey {
	if (seed.length !== 32) {
		throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
	}

	// Rebuild PKCS8 DER from prefix + seed
	const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
	const privateKey = createPrivateKey({
		key: pkcs8,
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey);

	// Extract raw public key
	const spki = publicKey.export({ type: "spki", format: "der" });
	const rawPub = spki.subarray(SPKI_PREFIX.length);

	return {
		keyId: keyId as KeyId,
		algorithm: "ed25519",
		privateKey,
		publicKey,
		publicKeyBase64: unpaddedBase64(rawPub),
		seed: Buffer.from(seed),
	};
}

// =============================================================================
// JSON SIGNING & VERIFICATION
// =============================================================================

export function signJson(
	obj: Record<string, unknown>,
	serverName: ServerName,
	key: SigningKey,
): Record<string, unknown> {
	// Remove signatures and unsigned before signing
	const copy: Record<string, unknown> = { ...obj };
	delete copy.signatures;
	delete copy.unsigned;

	const canonical = canonicalJson(copy);
	const sig = sign(null, Buffer.from(canonical), key.privateKey);

	// Merge signature into existing signatures
	const signatures = (obj.signatures ?? {}) as Record<
		string,
		Record<string, string>
	>;
	if (!signatures[serverName]) signatures[serverName] = {};
	(signatures[serverName] as Record<string, string>)[key.keyId] =
		unpaddedBase64(sig);

	obj.signatures = signatures;
	return obj;
}

export function verifyJsonSignature(
	obj: Record<string, unknown>,
	serverName: ServerName,
	keyId: KeyId,
	publicKeyBase64: string,
): boolean {
	// Remove signatures and unsigned before verifying
	const copy: Record<string, unknown> = { ...obj };
	delete copy.signatures;
	delete copy.unsigned;

	const canonical = canonicalJson(copy);

	// Get the signature
	const signatures = (obj.signatures ?? {}) as Record<
		string,
		Record<string, string>
	>;
	const serverSigs = signatures[serverName];
	if (!serverSigs) return false;
	const sigBase64 = serverSigs[keyId];
	if (!sigBase64) return false;

	const sigBuf = unpaddedBase64Decode(sigBase64);

	// Import the public key from raw bytes
	const rawPub = unpaddedBase64Decode(publicKeyBase64);
	const spki = Buffer.concat([SPKI_PREFIX, rawPub]);
	const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });

	return verify(null, Buffer.from(canonical), pubKey, sigBuf);
}

// =============================================================================
// EVENT SIGNING & VERIFICATION
// =============================================================================

export function signEvent(
	event: PDU,
	serverName: ServerName,
	key: SigningKey,
): PDU {
	// Compute content hash first
	const contentHash = computeContentHash(event);
	const withHash: PDU = { ...event, hashes: { sha256: contentHash } };

	// Redact, then strip unsigned and signatures for signing
	const redacted = redactEvent(withHash);
	const forSigning: Record<string, unknown> = {
		...redacted,
	} as unknown as Record<string, unknown>;
	delete forSigning.unsigned;
	delete forSigning.signatures;

	const canonical = canonicalJson(forSigning);
	const sig = sign(null, Buffer.from(canonical), key.privateKey);

	// Apply signature to the original event
	const signatures = { ...event.signatures };
	if (!signatures[serverName]) signatures[serverName] = {};
	signatures[serverName] = {
		...signatures[serverName],
		[key.keyId]: unpaddedBase64(sig),
	};

	return { ...withHash, signatures };
}

export function verifyEventSignature(
	event: PDU,
	serverName: ServerName,
	keyId: KeyId,
	publicKeyBase64: string,
): boolean {
	// Redact, strip unsigned and signatures
	const redacted = redactEvent(event);
	const forVerifying: Record<string, unknown> = {
		...redacted,
	} as unknown as Record<string, unknown>;
	delete forVerifying.unsigned;
	delete forVerifying.signatures;

	const canonical = canonicalJson(forVerifying);

	// Get the signature
	const serverSigs = event.signatures?.[serverName];
	if (!serverSigs) return false;
	const sigBase64 = serverSigs[keyId];
	if (!sigBase64) return false;

	const sigBuf = unpaddedBase64Decode(sigBase64);
	const rawPub = unpaddedBase64Decode(publicKeyBase64);
	const spki = Buffer.concat([SPKI_PREFIX, rawPub]);
	const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });

	return verify(null, Buffer.from(canonical), pubKey, sigBuf);
}
