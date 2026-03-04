export interface CallInviteContent {
	call_id: string;
	party_id: string;
	version: 0 | 1;
	lifetime: number;
	offer: { type: "offer"; sdp: string };
}

export interface CallCandidatesContent {
	call_id: string;
	party_id: string;
	version: 0 | 1;
	candidates: RTCIceCandidateInit[];
}

export interface RTCIceCandidateInit {
	candidate: string;
	sdpMLineIndex: number;
	sdpMid: string;
}

export interface CallAnswerContent {
	call_id: string;
	party_id: string;
	version: 0 | 1;
	answer: { type: "answer"; sdp: string };
}

export interface CallHangupContent {
	call_id: string;
	party_id: string;
	version: 0 | 1;
	reason?:
		| "ice_failed"
		| "invite_timeout"
		| "user_hangup"
		| "user_media_failed"
		| "user_busy"
		| "unknown_error";
}
