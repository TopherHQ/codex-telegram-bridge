#!/usr/bin/env node
import { defaultStateDir, formatSecurityResults, runSecurityChecks } from "../src/bridge.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") {
      flags.strict = true;
      continue;
    }
    if (arg === "--state-dir") {
      flags.stateDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--token-file") {
      flags.tokenFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    }
  }
  return flags;
}

function usage() {
  return [
    "Codex Telegram Bridge security check",
    "",
    "Usage:",
    "  node scripts/security-check.mjs [--state-dir DIR] [--token-file FILE] [--strict]",
    "",
    "--strict treats missing Telegram token, missing state, and empty allowlist as failures."
  ].join("\n");
}

const flags = parseArgs(process.argv);
if (flags.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const results = await runSecurityChecks({
  stateDir: flags.stateDir || defaultStateDir(),
  tokenFile: flags.tokenFile || null,
  strict: Boolean(flags.strict)
});

process.stdout.write(`${formatSecurityResults(results)}\n`);

if (results.some((result) => result.status === "fail")) {
  process.exitCode = 1;
}
