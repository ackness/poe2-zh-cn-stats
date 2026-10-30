#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSnapshot, currentSnapshot, cloneCandidate } from './sources.mjs';
import { generateFiles, writeGenerated, checkGenerated, activateGenerated, formatReport } from './snapshot.mjs';
import { checkNativeLocalizationCandidate, generateNativeLocalization, nativeBytes } from './native-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Usage: node src/cli.mjs <command>
  refresh [--trade-only]       Fetch a fresh candidate, generate, verify, then activate
  build [--snapshot PATH]     Offline rebuild; published snapshots become new revisions
  check [--snapshot PATH]     Check source hashes and byte-for-byte generated output
  report [--snapshot PATH]    Print the saved coverage report
  activate --snapshot PATH   Verify and activate a previously fetched candidate
  native --facts PATH --expected-manifest-sha256 SHA
                             Emit contextual native-ID localization candidates to stdout
  native-check --facts PATH --expected-manifest-sha256 SHA --candidate PATH
                             Compare a saved candidate with a fresh offline derivation
No command pushes GitHub changes or changes repository visibility.`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === 'native' || command === 'native-check') {
    const options = new Map();
    while (args.length) {
      const flag = args.shift();
      if (!['--facts', '--expected-manifest-sha256', ...(command === 'native-check' ? ['--candidate'] : [])].includes(flag)
          || options.has(flag) || !args[0] || args[0].startsWith('--')) throw new Error(`Unknown or incomplete native option: ${flag}`);
      options.set(flag, args.shift());
    }
    if (!options.has('--facts') || !options.has('--expected-manifest-sha256')
        || (command === 'native-check' && !options.has('--candidate'))) throw new Error(help);
    const generated = nativeBytes(await generateNativeLocalization(options.get('--facts'), options.get('--expected-manifest-sha256')));
    if (command === 'native') process.stdout.write(generated);
    else {
      await checkNativeLocalizationCandidate(options.get('--candidate'), generated);
      console.log('Native localization input pin and byte-identical candidate verified.');
    }
    return;
  }
  if (!['refresh', 'build', 'check', 'report', 'activate'].includes(command)) throw new Error(help);
  let tradeOnly = false;
  let supplied;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--trade-only' && command === 'refresh' && !tradeOnly) tradeOnly = true;
    else if (flag === '--snapshot' && command !== 'refresh' && !supplied && args[0] && !args[0].startsWith('--')) supplied = args.shift();
    else throw new Error(`Unknown or incomplete option: ${flag}\n${help}`);
  }
  if (command === 'refresh') {
    const { directory, manifest } = await fetchSnapshot(root, { tradeOnly });
    const files = await generateFiles(root, directory);
    await writeGenerated(directory, files);
    const report = await activateGenerated(root, directory);
    console.log(formatReport(report));
    if (manifest.errors.length) console.warn('Some supplemental downloads failed; inspect source-issues.json. No old page was substituted.');
    return;
  }
  const directory = supplied ? await realpath(path.resolve(root, supplied)) : await currentSnapshot(root);
  const base = await realpath(root);
  if (!directory.startsWith(base + path.sep)) throw new Error('Snapshot must be inside this repository');
  if (command === 'build') {
    const published = directory.startsWith(path.join(base, 'data', 'snapshots') + path.sep);
    const target = published ? (await cloneCandidate(root, directory)).directory : directory;
    await writeGenerated(target, await generateFiles(root, target));
    const report = published ? await activateGenerated(root, target) : await checkGenerated(root, target);
    console.log(formatReport(report));
  } else if (command === 'check') {
    console.log(formatReport(await checkGenerated(root, directory)));
    console.log('Source hashes and generated artifacts verified.');
  } else if (command === 'report') {
    console.log(formatReport(JSON.parse(await readFile(path.join(directory, 'generated', 'coverage.json'), 'utf8'))));
  } else {
    if (!supplied || !directory.startsWith(path.join(base, '.cache') + path.sep)) throw new Error('activate requires a candidate under .cache');
    const report = await activateGenerated(root, directory);
    console.log(formatReport(report));
  }
}

try { await main(); } catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
