export type RoomVersion =
	| "1"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"
	| "10"
	| "11";

export interface RoomVersionCapability {
	preferred: RoomVersion;
	support: Record<RoomVersion, "stable" | "unstable">;
}
