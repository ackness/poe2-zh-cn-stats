// Command-line producer for PoBR's i18n/zh-CN/stat_lines.json: select literal
// effect translations by the exact CSD branches a PoBR ordinary-facts receipt
// consumed (native-selected-translations.mjs) and append them to the previous
// pairs. Output is a fresh .cache candidate plus a receipt; nothing is adopted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSelectedTranslations } from './native-selected-translations.mjs';
import { parseRequiredArgs, readPinnedJson, sha256 as digest } from './pinned.mjs';

// The receipt pins every module this producer executes.
const IMPLEMENTATION = ['stat-lines.mjs', 'native-selected-translations.mjs', 'pinned.mjs'];

const required = (ok, message) => { if (!ok) throw new Error(message); };
const FLAGS = ['selection', 'selection-sha256', 'native', 'native-sha256', 'legacy', 'legacy-sha256', 'out'];
const pinned = (file, expected) => readPinnedJson(file, expected, { kind: 'translation input' });

export function parseStatLineArgs(argv) {
  return parseRequiredArgs(argv, FLAGS, {
    invalidMessage: 'invalid or duplicate translation option',
    missingMessage: 'missing translation argument',
  });
}

export function createStatLines(options) {
  const result = nativeSelectedTranslations(pinned(options.legacy, options['legacy-sha256']),
    pinned(options.selection, options['selection-sha256']), pinned(options.native, options['native-sha256']));
  const out = path.resolve(options.out), cache = path.resolve(fileURLToPath(new URL('../../.cache', import.meta.url)));
  // A fresh candidate directory prevents in-place edits to this repository or a runtime snapshot.
  required(out.startsWith(cache + path.sep), 'Output must be a fresh repository cache candidate');
  required(fs.realpathSync(path.dirname(out)) === path.dirname(out), 'Output parent contains a symlink');
  fs.mkdirSync(out);
  const lines = JSON.stringify(result.pairs, null, 2) + '\n';
  fs.writeFileSync(path.join(out, 'stat_lines.json'), lines, { flag: 'wx' });
  const receipt = { ...result.report, inputs: options,
    files: { 'stat_lines.json': { bytes: Buffer.byteLength(lines), sha256: digest(lines) } },
    implementation: Object.fromEntries(IMPLEMENTATION.map(file =>
      [`src/pobr/${file}`, digest(fs.readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url))))])),
    adoption: 'not-adopted' };
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = createStatLines(parseStatLineArgs(process.argv.slice(2)));
  console.log(`native selected translations: ${receipt.added.length} literal pairs added; ${receipt.excluded.length} selections retained/excluded`);
}
