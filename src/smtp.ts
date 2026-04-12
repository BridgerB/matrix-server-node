import * as net from "node:net";
import * as tls from "node:tls";

export interface SmtpConfig {
	host: string;
	port: number;
	secure: boolean;
	username?: string;
	password?: string;
	from: string;
}

/** Read SMTP configuration from environment variables. Returns undefined if SMTP_HOST is not set. */
export const getSmtpConfig = (): SmtpConfig | undefined => {
	const host = process.env.SMTP_HOST;
	if (!host) return undefined;

	return {
		host,
		port: parseInt(process.env.SMTP_PORT ?? "587", 10),
		secure: process.env.SMTP_SECURE === "true",
		username: process.env.SMTP_USERNAME,
		password: process.env.SMTP_PASSWORD,
		from: process.env.SMTP_FROM ?? `noreply@${process.env.SERVER_NAME ?? "localhost"}`,
	};
};

/** Read a line (ending with \r\n) from the socket. Returns the full line including status code. */
const readResponse = (
	socket: net.Socket | tls.TLSSocket,
): Promise<string> => {
	return new Promise<string>((resolve, reject) => {
		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			// SMTP responses can be multi-line (xxx-... continuation, xxx ... final)
			const lines = buffer.split("\r\n");
			// Check if we have a final line (one that starts with "xxx " not "xxx-")
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.length >= 4 && line[3] === " ") {
					// This is the final response line
					socket.removeListener("data", onData);
					socket.removeListener("error", onError);
					resolve(buffer);
					return;
				}
			}
			// If the last element is empty string (trailing \r\n), check second-to-last
			if (lines.length >= 2) {
				const lastNonEmpty = lines[lines.length - 2]!;
				if (lastNonEmpty.length >= 4 && lastNonEmpty[3] === " ") {
					socket.removeListener("data", onData);
					socket.removeListener("error", onError);
					resolve(buffer);
					return;
				}
			}
		};
		const onError = (err: Error) => {
			socket.removeListener("data", onData);
			reject(err);
		};
		socket.on("data", onData);
		socket.on("error", onError);
	});
};

/** Send a command and read the response. Throws if the response status doesn't start with an expected prefix. */
const sendCommand = async (
	socket: net.Socket | tls.TLSSocket,
	command: string,
	expectedPrefix: string,
): Promise<string> => {
	return new Promise<string>((resolve, reject) => {
		socket.write(command + "\r\n", "utf-8", (err) => {
			if (err) {
				reject(err);
				return;
			}
			readResponse(socket).then((response) => {
				const code = response.slice(0, 3);
				if (!code.startsWith(expectedPrefix)) {
					reject(
						new Error(
							`SMTP error: expected ${expectedPrefix}xx, got: ${response.trim()}`,
						),
					);
				} else {
					resolve(response);
				}
			}, reject);
		});
	});
};

/** Connect a plain TCP socket. */
const connectPlain = (host: string, port: number): Promise<net.Socket> => {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host, port }, () => {
			resolve(socket);
		});
		socket.on("error", reject);
		socket.setTimeout(30_000);
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error("SMTP connection timeout"));
		});
	});
};

/** Connect a TLS socket directly (for SMTPS / port 465). */
const connectTls = (host: string, port: number): Promise<tls.TLSSocket> => {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
			resolve(socket);
		});
		socket.on("error", reject);
		socket.setTimeout(30_000);
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error("SMTP TLS connection timeout"));
		});
	});
};

/** Upgrade a plain socket to TLS via STARTTLS. */
const upgradeToTls = (
	socket: net.Socket,
	host: string,
): Promise<tls.TLSSocket> => {
	return new Promise((resolve, reject) => {
		const tlsSocket = tls.connect(
			{ socket, host, rejectUnauthorized: false },
			() => {
				resolve(tlsSocket);
			},
		);
		tlsSocket.on("error", reject);
	});
};

/**
 * Send an email via SMTP.
 *
 * Supports plain, STARTTLS, and direct TLS connections.
 * Supports AUTH LOGIN for authentication.
 */
export const sendEmail = async (
	config: SmtpConfig,
	to: string,
	subject: string,
	body: string,
): Promise<void> => {
	let socket: net.Socket | tls.TLSSocket;

	if (config.secure) {
		socket = await connectTls(config.host, config.port);
	} else {
		socket = await connectPlain(config.host, config.port);
	}

	try {
		// Read greeting
		const greeting = await readResponse(socket);
		if (!greeting.startsWith("220")) {
			throw new Error(`SMTP greeting error: ${greeting.trim()}`);
		}

		// EHLO
		const ehloResponse = await sendCommand(socket, `EHLO localhost`, "2");

		// STARTTLS if not already secure
		if (!config.secure && ehloResponse.includes("STARTTLS")) {
			await sendCommand(socket, "STARTTLS", "2");
			socket = await upgradeToTls(socket as net.Socket, config.host);
			// Re-EHLO after STARTTLS
			await sendCommand(socket, `EHLO localhost`, "2");
		}

		// AUTH LOGIN if credentials provided
		if (config.username && config.password) {
			await sendCommand(socket, "AUTH LOGIN", "3");
			await sendCommand(
				socket,
				Buffer.from(config.username, "utf-8").toString("base64"),
				"3",
			);
			await sendCommand(
				socket,
				Buffer.from(config.password, "utf-8").toString("base64"),
				"2",
			);
		}

		// MAIL FROM
		await sendCommand(socket, `MAIL FROM:<${config.from}>`, "2");

		// RCPT TO
		await sendCommand(socket, `RCPT TO:<${to}>`, "2");

		// DATA
		await sendCommand(socket, "DATA", "3");

		// Compose email headers + body
		const date = new Date().toUTCString();
		const message = [
			`From: ${config.from}`,
			`To: ${to}`,
			`Subject: ${subject}`,
			`Date: ${date}`,
			`MIME-Version: 1.0`,
			`Content-Type: text/html; charset=utf-8`,
			`Content-Transfer-Encoding: 8bit`,
			"",
			body,
			".",
		].join("\r\n");

		await sendCommand(socket, message, "2");

		// QUIT
		try {
			await sendCommand(socket, "QUIT", "2");
		} catch {
			// Some servers close before responding to QUIT
		}
	} finally {
		socket.destroy();
	}
};
