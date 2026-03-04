import type { Base64, MxcUri } from "./identifiers.ts";

export interface ThumbnailInfo {
	h?: number;
	w?: number;
	mimetype?: string;
	size?: number;
}

export interface FileInfo {
	mimetype?: string;
	size?: number;
	thumbnail_url?: MxcUri;
	thumbnail_file?: EncryptedFile;
	thumbnail_info?: ThumbnailInfo;
}

export interface ImageInfo extends FileInfo {
	h?: number;
	w?: number;
}

export interface AudioInfo {
	duration?: number;
	mimetype?: string;
	size?: number;
}

export interface VideoInfo {
	duration?: number;
	h?: number;
	w?: number;
	mimetype?: string;
	size?: number;
	thumbnail_url?: MxcUri;
	thumbnail_file?: EncryptedFile;
	thumbnail_info?: ThumbnailInfo;
}

export interface EncryptedFile {
	url: MxcUri;
	key: JsonWebKey;
	iv: string;
	hashes: { sha256: Base64 };
	v: "v2";
}

export interface JsonWebKey {
	kty: "oct";
	key_ops: ("encrypt" | "decrypt")[];
	alg: "A256CTR";
	k: Base64;
	ext: true;
}
