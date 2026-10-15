#!/usr/bin/env node
import { main } from '../src/cli.js';
import { stopAllChecks } from '../src/run.js';

// Ctrl-C stops every running check's process group before exiting.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    stopAllChecks();
    process.exit(code);
  });
}

process.exitCode = await main(process.argv.slice(2), process);
