import type { DeviceId, EventId, MxcUri } from "./identifiers.ts";
import type {
	AudioInfo,
	EncryptedFile,
	FileInfo,
	ImageInfo,
	VideoInfo,
} from "./media-info.ts";

export type MsgType =
	| "m.text"
	| "m.emote"
	| "m.notice"
	| "m.image"
	| "m.file"
	| "m.audio"
	| "m.video"
	| "m.location"
	| "m.key.verification.request";

export interface RoomMessageContent {
	msgtype: MsgType;
	body: string;
	format?: "org.matrix.custom.html";
	formatted_body?: string;

	// media fields (for image/file/audio/video)
	url?: MxcUri;
	file?: EncryptedFile;
	info?: FileInfo | ImageInfo | AudioInfo | VideoInfo;
	thumbnail_url?: MxcUri;
	thumbnail_file?: EncryptedFile;
	thumbnail_info?: import("./media-info.ts").ThumbnailInfo;

	// location
	geo_uri?: string;

	// reply
	"m.relates_to"?: RelatesTo;

	// extensible events (MSC1767)
	"m.text"?: TextRepresentation[];
	"m.html"?: TextRepresentation[];
}

export interface TextRepresentation {
	body: string;
	mimetype?: string;
}

export interface RelatesTo {
	"m.in_reply_to"?: { event_id: EventId };
	rel_type?: string; // "m.annotation", "m.thread", "m.replace", "m.reference"
	event_id?: EventId;
	is_falling_back?: boolean;
	key?: string; // for annotations/reactions
}

export interface RoomRedactionContent {
	redacts?: EventId; // v11+: in content; earlier: top-level
	reason?: string;
}

export interface RoomEncryptedContent {
	algorithm: "m.olm.v1.curve25519-aes-sha2" | "m.megolm.v1.aes-sha2";
	ciphertext: string | Record<string, { type: number; body: string }>;
	sender_key?: string;
	device_id?: DeviceId;
	session_id?: string;
}

export interface ReactionContent {
	"m.relates_to": {
		rel_type: "m.annotation";
		event_id: EventId;
		key: string; // the emoji or text
	};
}

export interface StickerContent {
	body: string;
	info: ImageInfo;
	url: MxcUri;
}
