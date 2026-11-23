// Shared SHA-256, pinned-file reading, and required-flag CLI parsing for src/pobr/ producers.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const HEX64 = /^[0-9a-f]{64}$/u;
export const sha256 = raw => createHash('sha256').update(raw).digest('hex');
export const pinOf = raw => ({ bytes: raw.length, sha256: sha256(raw) });

/**
 * Read a regular file (never following a trailing symlink) and verify its SHA-256 and optional
 * exact byte length or upper bound.
 */
export function readPinned(file, expectedSha256, {
  bytes,
  maxBytes,
  rejectSymlinkPath = false,
  label,
  kind = 'Input',
} = {}) {
  if (typeof expectedSha256 !== 'string' || !HEX64.test(expectedSha256)) {
    throw new Error(label ? `${label}: missing or invalid SHA256` : 'Missing external SHA256');
  }
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new Error(label ? `${label}: invalid declared input size` : 'Invalid declared input size');
  }
  const absolute = path.resolve(file);
  if (rejectSymlinkPath && fs.realpathSync(absolute) !== absolute) {
    throw new Error(`${kind} path contains a symlink`);
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(label ? `${label}: not a regular file` : `${kind} must be a regular file`);
    }
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw new Error(`${kind} is not a bounded regular file`);
    }
    if (!label && bytes !== undefined && stat.size !== bytes) {
      throw new Error(`${kind} size differs from manifest`);
    }
    const raw = fs.readFileSync(fd);
    if (raw.length !== stat.size) {
      throw new Error(`${kind} size changed while reading`);
    }
    if (label) {
      if ((bytes !== undefined && raw.length !== bytes) || sha256(raw) !== expectedSha256) {
        throw new Error(`${label}: ${absolute} differs from its pin`);
      }
    } else if (sha256(raw) !== expectedSha256) {
      throw new Error(`${kind} SHA256 mismatch: ${absolute}`);
    }
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read and parse a bounded regular JSON file pinned by SHA-256. */
export function readPinnedJson(file, expectedSha256, options = {}) {
  const raw = readPinned(file, expectedSha256, { maxBytes: 128 * 1024 * 1024, ...options });
  return JSON.parse(raw.toString('utf8'));
}

/**
 * Parse a fixed list of required single-value string CLI flags with node:util parseArgs.
 * Rejects unknown flags, positionals, duplicates, empty values and missing flags.
 */
export function parseRequiredArgs(args, flags, {
  invalidMessage = 'Invalid or duplicate option',
  missingMessage = 'Missing required option',
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: Object.fromEntries(flags.map(flag => [flag, { type: 'string', multiple: true }])),
      allowPositionals: false,
    }));
  } catch {
    throw new Error(invalidMessage);
  }
  for (const flag of flags) {
    const list = values[flag];
    if (list && (list.length !== 1 || !list[0])) throw new Error(invalidMessage);
  }
  const result = {};
  for (const flag of flags) {
    if (!values[flag]?.length) throw new Error(missingMessage);
    result[flag] = values[flag][0];
  }
  return result;
}
