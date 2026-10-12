#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSnapshot, activateSnapshot, currentSnapshot, cloneCandidate } from './sources.mjs';
import { generateFiles, writeGenerated, checkGenerated, formatReport } from './snapshot.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Usage: node src/cli.mjs <command>
  refresh [--trade-only]       Fetch a fresh candidate, generate, verify, then activate
  build [--snapshot PATH]     Offline rebuild; published snapshots become new revisions
  check [--snapshot PATH]     Check source hashes and byte-for-byte generated output
  report [--snapshot PATH]    Print the saved coverage report
  activate --snapshot PATH   Verify and activate a previously fetched candidate
No command pushes GitHub changes or changes repository visibility.`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
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
    const report = await checkGenerated(root, directory);
    await activateSnapshot(root, directory, manifest.id);
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
    const report = await checkGenerated(root, target);
    if (published) await activateSnapshot(root, target, report.snapshot);
    console.log(formatReport(report));
  } else if (command === 'check') {
    console.log(formatReport(await checkGenerated(root, directory)));
    console.log('Source hashes and generated artifacts verified.');
  } else if (command === 'report') {
    console.log(formatReport(JSON.parse(await readFile(path.join(directory, 'generated', 'coverage.json'), 'utf8'))));
  } else {
    if (!supplied || !directory.startsWith(path.join(base, '.cache') + path.sep)) throw new Error('activate requires a candidate under .cache');
    const report = await checkGenerated(root, directory);
    await activateSnapshot(root, directory, report.snapshot);
    console.log(formatReport(report));
  }
}

try { await main(); } catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
