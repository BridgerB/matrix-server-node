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

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const reconstructPublicKey = (publicKeyBase64: string): KeyObject => {
	const rawPub = unpaddedBase64Decode(publicKeyBase64);
	const spki = Buffer.concat([SPKI_PREFIX, rawPub]);
	return createPublicKey({ key: spki, format: "der", type: "spki" });
};

export interface SigningKey {
	keyId: KeyId;
	algorithm: "ed25519";
	privateKey: KeyObject;
	publicKey: KeyObject;
	publicKeyBase64: string; // Unpadded standard base64 of raw 32-byte public key
	seed: Buffer; // Raw 32-byte seed for persistence
}

export const unpaddedBase64 = (buf: Buffer): string =>
	buf.toString("base64").replace(/=+$/, "");

export const unpaddedBase64Decode = (str: string): Buffer => {
	const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
	return Buffer.from(padded, "base64");
};

export const generateSigningKey = (_serverName: string): SigningKey => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");

	const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
	const seed = pkcs8.subarray(PKCS8_PREFIX.length);

	const spki = publicKey.export({ type: "spki", format: "der" });
	const rawPub = spki.subarray(SPKI_PREFIX.length);

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
};

export const importSigningKey = (keyId: string, seed: Buffer): SigningKey => {
	if (seed.length !== 32) {
		throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
	}

	const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
	const privateKey = createPrivateKey({
		key: pkcs8,
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey);

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
};

export const signJson = (
	obj: Record<string, unknown>,
	serverName: ServerName,
	key: SigningKey,
): Record<string, unknown> => {
	const { signatures: _s, unsigned: _u, ...copy } = obj;

	const canonical = canonicalJson(copy);
	const sig = sign(null, Buffer.from(canonical), key.privateKey);

	const signatures = (obj.signatures ?? {}) as Record<
		string,
		Record<string, string>
	>;
	signatures[serverName] ??= {};
	(signatures[serverName] as Record<string, string>)[key.keyId] =
		unpaddedBase64(sig);

	obj.signatures = signatures;
	return obj;
};

export const verifyJsonSignature = (
	obj: Record<string, unknown>,
	serverName: ServerName,
	keyId: KeyId,
	publicKeyBase64: string,
): boolean => {
	const { signatures: _s, unsigned: _u, ...copy } = obj;

	const canonical = canonicalJson(copy);

	const signatures = (obj.signatures ?? {}) as Record<
		string,
		Record<string, string>
	>;
	const sigBase64 = signatures[serverName]?.[keyId];
	if (!sigBase64) return false;

	const sigBuf = unpaddedBase64Decode(sigBase64);

	const pubKey = reconstructPublicKey(publicKeyBase64);

	return verify(null, Buffer.from(canonical), pubKey, sigBuf);
};

export const signEvent = (
	event: PDU,
	serverName: ServerName,
	key: SigningKey,
): PDU => {
	const contentHash = computeContentHash(event);
	const withHash: PDU = { ...event, hashes: { sha256: contentHash } };

	const redacted = redactEvent(withHash);
	const {
		unsigned: _u,
		signatures: _s,
		...forSigning
	} = redacted as unknown as Record<string, unknown>;

	const canonical = canonicalJson(forSigning);
	const sig = sign(null, Buffer.from(canonical), key.privateKey);

	const signatures = { ...event.signatures };
	signatures[serverName] = {
		...signatures[serverName],
		[key.keyId]: unpaddedBase64(sig),
	};

	return { ...withHash, signatures };
};

export const verifyEventSignature = (
	event: PDU,
	serverName: ServerName,
	keyId: KeyId,
	publicKeyBase64: string,
): boolean => {
	const redacted = redactEvent(event);
	const {
		unsigned: _u,
		signatures: _s,
		...forVerifying
	} = redacted as unknown as Record<string, unknown>;

	const canonical = canonicalJson(forVerifying);

	const sigBase64 = event.signatures?.[serverName]?.[keyId];
	if (!sigBase64) return false;

	const sigBuf = unpaddedBase64Decode(sigBase64);
	const pubKey = reconstructPublicKey(publicKeyBase64);

	return verify(null, Buffer.from(canonical), pubKey, sigBuf);
};
