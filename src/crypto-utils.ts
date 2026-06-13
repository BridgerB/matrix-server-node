import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
// scrypt cost (N). Configurable via SCRYPT_COST because scrypt runs on libuv's
// threadpool, which DNS lookups for outbound federation also use — under heavy
// concurrent registration/login a high cost starves federation DNS and causes
// sync timeouts. The default stays strong (16384) for real deployments; test
// harnesses (Complement) lower it. N must be a power of two. Note: N is not
// stored in the hash, so it must be consistent for a given account's lifetime
// (fine for Complement, which uses a fresh DB per test).
const SCRYPT_COST = (() => {
	const n = Number.parseInt(process.env.SCRYPT_COST ?? "", 10);
	return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0 ? n : 16384;
})();
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELIZATION = 1; // p
const SALT_LENGTH = 32;

const scryptAsync = (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number },
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		scrypt(
			password,
			salt,
			keylen,
			{ N: options.N, r: options.r, p: options.p },
			(err, derivedKey) => {
				if (err) reject(err);
				else resolve(derivedKey);
			},
		);
	});

export const hashPassword = async (password: string): Promise<string> => {
	const salt = randomBytes(SALT_LENGTH);
	const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_COST,
		r: SCRYPT_BLOCK_SIZE,
		p: SCRYPT_PARALLELIZATION,
	});
	return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
};

export const verifyPassword = async (
	password: string,
	hash: string,
): Promise<boolean> => {
	const parts = hash.split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") {
		// Legacy plaintext comparison for old accounts
		return password === hash;
	}
	const salt = Buffer.from(parts[1]!, "base64");
	const storedKey = Buffer.from(parts[2]!, "base64");
	const derived = await scryptAsync(password, salt, storedKey.length, {
		N: SCRYPT_COST,
		r: SCRYPT_BLOCK_SIZE,
		p: SCRYPT_PARALLELIZATION,
	});
	return timingSafeEqual(derived, storedKey);
};
