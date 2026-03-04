/** Raw JSON value - used where content is opaque */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;
