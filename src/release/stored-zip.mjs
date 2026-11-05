// Deterministic ZIP archives: the convention of RePoE's release:build
// (sorted members, 1980-01-01 00:00:00, Unix 0644 regular files, version 2.0,
// no extra fields or comments) with STORED members. Deflate output depends on
// the zlib build (Node's bundled zlib differs from the system one), so stored
// bytes are the only choice that any platform or language reproduces exactly:
// Python's zipfile writes the same bytes for the same ZipInfo fields.
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(raw) {
  let crc = 0xffffffff;
  for (const byte of raw) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const VERSION = 20;
const UNIX = 3;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const REGULAR_0644 = 0o100644 * 0x10000;
const MAX32 = 0xffffffff;

function memberName(name) {
  if (typeof name !== 'string' || !/^[\x21-\x7e]+$/u.test(name) || name.includes('\\') || name.includes(':')
    || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe or non-ASCII archive member: ${JSON.stringify(name)}`);
  }
  return Buffer.from(name, 'ascii');
}

// members: Map or object of name -> Buffer. Returns the archive bytes.
export function storedZip(members) {
  const entries = [...(members instanceof Map ? members : Object.entries(members))]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > 0xffff) throw new Error('Too many archive members');
  const local = [], central = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const [name, raw] = entries[i];
    if (i && entries[i - 1][0] === name) throw new Error(`Duplicate archive member: ${name}`);
    const encodedName = memberName(name);
    if (!Buffer.isBuffer(raw) || raw.length > MAX32 - 1) throw new Error(`Invalid archive member bytes: ${name}`);
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0, 10); // 00:00:00
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(encodedName.length, 26);
    header.writeUInt16LE(0, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt8(VERSION, 4);
    record.writeUInt8(UNIX, 5);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(raw.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(encodedName.length, 28);
    record.writeUInt32LE(REGULAR_0644, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, encodedName, raw);
    central.push(record, encodedName);
    offset += header.length + encodedName.length + raw.length;
    if (offset > MAX32) throw new Error('Archive exceeds 4 GiB; ZIP64 is not supported');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// Read a classic (non-ZIP64) archive through its central directory and check
// every member's CRC. Returns Map name -> {raw, method, mode}. With `select`, only the members whose
// name it accepts are read (a large input package need not be inflated whole); names stay unique.
export function readZip(archive, select = null) {
  const endAt = archive.length - 22;
  if (endAt < 0 || archive.readUInt32LE(endAt) !== 0x06054b50) {
    throw new Error('Not a comment-free ZIP archive');
  }
  const count = archive.readUInt16LE(endAt + 10);
  let at = archive.readUInt32LE(endAt + 16);
  const members = new Map(), seen = new Set();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const skip = archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    const mode = archive.readUInt32LE(at + 38) >>> 16;
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + skip;
    if (seen.has(name)) throw new Error(`Duplicate ZIP member: ${name}`);
    seen.add(name);
    if (select && !select(name)) continue;
    const dataAt = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const stored = archive.subarray(dataAt, dataAt + compressed);
    const raw = method === 0 ? Buffer.from(stored) : method === 8 ? inflateRawSync(stored) : null;
    if (raw === null || raw.length !== size || crc32(raw) !== crc) throw new Error(`Corrupt ZIP member: ${name}`);
    members.set(name, { raw, method, mode });
  }
  return members;
}
