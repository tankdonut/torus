/**
 * Minimal ustar tar reader/writer, no dependencies. Writer output is
 * deterministic: entries sorted by path, mtime 0, uid/gid 0, empty
 * uname/gname, file modes preserved. gzip compression belongs to the caller
 * (node:zlib) so the reader only ever parses plain tar archives.
 */

const BLOCK = 512;

/** Fixed-length octal field: zero-padded digits + NUL terminator. */
function octalField(value, length) {
	const digits = length - 1;
	const text = value.toString(8);
	if (text.length > digits) {
		throw new Error(`value ${value} does not fit in ${digits} octal digits`);
	}
	return Buffer.from(`${text.padStart(digits, "0")}\0`, "ascii");
}

function parseOctal(field) {
	const text = field.toString("ascii").replaceAll("\0", "").replaceAll(" ", "");
	return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/**
 * ustar splits long paths into a 155-byte prefix and a 100-byte name at a
 * "/" boundary; pick the latest split that fits both fields.
 */
function splitPath(entryPath) {
	if (Buffer.byteLength(entryPath, "utf8") <= 100) {
		return { name: entryPath, prefix: "" };
	}
	let best = null;
	let at = entryPath.indexOf("/");
	while (at !== -1) {
		const prefix = entryPath.slice(0, at);
		const name = entryPath.slice(at + 1);
		if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
			best = { name, prefix };
		}
		at = entryPath.indexOf("/", at + 1);
	}
	if (best === null) {
		throw new Error(`path does not fit ustar fields: ${entryPath}`);
	}
	return best;
}

function defaultMode(entry) {
	if (entry.mode !== undefined) {
		return entry.mode;
	}
	return entry.typeflag === "5" ? 0o755 : entry.typeflag === "2" ? 0o777 : 0o644;
}

function writeAscii(block, text, offset, length, what) {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > length) {
		throw new Error(`${what} does not fit in ${length} bytes: ${text}`);
	}
	block.write(text, offset, length, "utf8");
}

/** One 512-byte ustar header block with a correct checksum. */
function headerBlock(entry) {
	const block = Buffer.alloc(BLOCK);
	const { name, prefix } = splitPath(entry.path);
	writeAscii(block, name, 0, 100, "entry name");
	block.set(octalField(defaultMode(entry) & 0o7777, 8), 100);
	block.set(octalField(0, 8), 108); // uid
	block.set(octalField(0, 8), 116); // gid
	const bytes = entry.typeflag === "0" ? entry.bytes : Buffer.alloc(0);
	block.set(octalField(bytes.length, 12), 124);
	block.set(octalField(0, 12), 136); // mtime
	block.fill(" ", 148, 156); // checksum field counts as spaces while summing
	block.write(entry.typeflag, 156, 1, "ascii");
	if (entry.typeflag === "2") {
		writeAscii(block, entry.linkpath ?? "", 157, 100, "linkpath");
	}
	block.write("ustar\0", 257, 6, "ascii");
	block.write("00", 263, 2, "ascii");
	block.set(octalField(0, 8), 329); // devmajor
	block.set(octalField(0, 8), 337); // devminor
	writeAscii(block, prefix, 345, 155, "entry prefix");
	const sum = block.reduce((acc, byte) => acc + byte, 0);
	const checksum = sum.toString(8).padStart(6, "0");
	block.write(`${checksum}\0 `, 148, 8, "ascii");
	return block;
}

/**
 * Serializes entries ({ path, typeflag: "0"|"2"|"5", mode?, bytes?, linkpath? })
 * into a plain ustar archive. Input order does not matter: entries are sorted
 * by path so identical trees give byte-identical archives.
 */
export function writeTar(entries) {
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const chunks = [];
	for (const entry of sorted) {
		if (entry.typeflag === "0" && !Buffer.isBuffer(entry.bytes)) {
			throw new Error(`file entry needs bytes: ${entry.path}`);
		}
		if (entry.typeflag === "2" && typeof entry.linkpath !== "string") {
			throw new Error(`symlink entry needs linkpath: ${entry.path}`);
		}
		chunks.push(headerBlock(entry));
		if (entry.typeflag === "0" && entry.bytes.length > 0) {
			chunks.push(entry.bytes);
			const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
			if (pad > 0) {
				chunks.push(Buffer.alloc(pad));
			}
		}
	}
	chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
	return Buffer.concat(chunks);
}

/** Rejects names that could escape the extraction root. */
function safeEntryPath(raw) {
	if (raw.startsWith("/") || raw.includes("../")) {
		throw new Error(`refusing unsafe entry name: ${raw}`);
	}
	return raw;
}

/**
 * Parses a plain ustar archive back into entries ({ path, typeflag, mode,
 * size, bytes?, linkpath? }). Validates header checksums and refuses entry
 * names that are absolute or traverse upwards.
 */
export function readTar(buffer) {
	const entries = [];
	for (let offset = 0; offset + BLOCK <= buffer.length; offset += BLOCK) {
		const block = buffer.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) {
			break; // end-of-archive marker
		}
		if (block.toString("ascii", 257, 263) !== "ustar\0") {
			throw new Error(`bad magic at offset ${offset}`);
		}
		const stored = parseOctal(block.subarray(148, 156));
		const sum = block.reduce((acc, byte, i) => acc + (i >= 148 && i < 156 ? 32 : byte), 0);
		if (stored !== sum) {
			throw new Error(`header checksum mismatch at offset ${offset}`);
		}
		const name = block.toString("utf8", 0, 100).replaceAll("\0", "");
		const prefix = block.toString("utf8", 345, 500).replaceAll("\0", "");
		const entry = {
			path: safeEntryPath(prefix ? `${prefix}/${name}` : name),
			typeflag: String.fromCharCode(block[156]),
			mode: parseOctal(block.subarray(100, 108)),
			size: parseOctal(block.subarray(124, 136)),
		};
		if (entry.typeflag === "0" || entry.typeflag === "\0") {
			entry.typeflag = "0";
			if (offset + BLOCK + entry.size > buffer.length) {
				throw new Error(`truncated data for entry ${entry.path}`);
			}
			entry.bytes = Buffer.from(buffer.subarray(offset + BLOCK, offset + BLOCK + entry.size));
		} else if (entry.typeflag === "2") {
			entry.linkpath = block.toString("utf8", 157, 257).replaceAll("\0", "");
		} else if (entry.typeflag !== "5") {
			throw new Error(`unsupported typeflag "${entry.typeflag}" for entry ${entry.path}`);
		}
		entries.push(entry);
		offset += Math.ceil(entry.size / BLOCK) * BLOCK;
	}
	return entries;
}
