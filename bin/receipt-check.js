#!/usr/bin/env node
import { main } from '../src/cli.js';
import { stopAllChecks } from '../src/run.js';
import { removeLiveCopies } from '../src/verify.js';

// Ctrl-C stops every running check's process group and removes the clean
// copy before exiting.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    stopAllChecks();
    removeLiveCopies();
    process.exit(code);
  });
}

process.exitCode = await main(process.argv.slice(2), process);
