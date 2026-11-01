/**
 * Self-contained gzip+ustar extractor for the bundled dependency tree.
 * Node builtins only — the launcher runs under both node (source) and bun
 * (compiled). Archive entries with absolute paths or any `..` component are
 * rejected before a single byte is written; a bad header checksum aborts
 * extraction. Hardlinks and device nodes are refused — the packed tree ships
 * only files, directories, and symlinks.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

function readString(block, start, end) {
	return block.subarray(start, end).toString("latin1").replace(/\0.*$/, "");
}

function readOctal(block, start, end) {
	const text = readString(block, start, end).trim();
	return text === "" ? 0 : Number.parseInt(text, 8);
}

function headerChecksum(block) {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) {
		sum += i >= 148 && i < 156 ? 32 : block[i];
	}
	return sum;
}

/**
 * Entry name from the ustar name+prefix fields. Returns null for the
 * all-zero end-of-archive header. Throws on names that could escape the
 * extraction root: absolute paths, embedded NUL tricks, or any `..` path
 * component (`..`, `foo/..`, `a/../b` alike).
 */
function entryName(block) {
	const rawName = readString(block, 0, 100);
	const prefix = readString(block, 345, 500);
	const name = prefix === "" ? rawName : `${prefix}/${rawName}`;
	if (name === "") return null;
	if (name.startsWith("/")) throw new Error(`tar entry has an absolute path: ${name}`);
	if (name.split("/").includes(".."))
		throw new Error(`tar entry escapes the extraction root: ${name}`);
	return name.replace(/\/+$/, "");
}

/**
 * Extract a gzipped ustar archive under destRoot. Returns entry counts;
 * throws on structural anomalies so a partial tree is never mistaken for a
 * complete one.
 */
export function extractTarGz(gzBytes, destRoot) {
	const data = gunzipSync(gzBytes);
	let offset = 0;
	let files = 0;
	let dirs = 0;
	let links = 0;
	let sawEnd = false;
	while (offset + BLOCK <= data.length) {
		const header = data.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) {
			sawEnd = true;
			break;
		}
		const stored = readOctal(header, 148, 156);
		if (stored === 0 || stored !== headerChecksum(header)) {
			throw new Error(`tar header checksum mismatch at byte ${offset}`);
		}
		const name = entryName(header);
		if (name === null) throw new Error(`tar entry without a name at byte ${offset}`);
		const mode = readOctal(header, 100, 108);
		const size = readOctal(header, 124, 136);
		const typeflag = String.fromCharCode(header[156]);
		const linkname = readString(header, 157, 257);
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > data.length) throw new Error(`tar entry data overruns the archive: ${name}`);
		const dest = path.join(destRoot, ...name.split("/"));
		if (typeflag === "0" || typeflag === "\0") {
			mkdirSync(path.dirname(dest), { recursive: true });
			writeFileSync(dest, data.subarray(dataStart, dataEnd));
			chmodSync(dest, mode & 0o777 || 0o644);
			files++;
		} else if (typeflag === "5") {
			mkdirSync(dest, { recursive: true });
			chmodSync(dest, mode & 0o777 || 0o755);
			dirs++;
		} else if (typeflag === "2") {
			if (linkname === "" || linkname.startsWith("/")) {
				throw new Error(`tar symlink has an unsafe target: ${name} -> ${linkname}`);
			}
			mkdirSync(path.dirname(dest), { recursive: true });
			symlinkSync(linkname, dest);
			links++;
		} else {
			throw new Error(`tar entry type "${typeflag}" is not supported: ${name}`);
		}
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
	}
	if (!sawEnd) throw new Error("tar archive is truncated (no end-of-archive block)");
	return { files, dirs, links };
}

/**
 * Replace <root>/node_modules with the extracted archive contents. Entries
 * are relative to node_modules itself (the packer archives that directory),
 * so they land inside the wiped target by construction; names are still
 * validated by extractTarGz (no absolute paths, no `..` components).
 */
export function extractTree(root, gzBytes) {
	const target = path.join(root, "node_modules");
	rmSync(target, { recursive: true, force: true });
	return extractTarGz(gzBytes, target);
}
