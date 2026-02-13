#!/usr/bin/env node
/**
 * One-command setup for the Agent Dashboard Cloud Relay.
 *
 * Usage: node setup.js
 *
 * This script:
 *   1. Creates the KV namespace (or reuses existing one)
 *   2. Patches wrangler.toml with the namespace ID
 *   3. Deploys the worker
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOML_PATH = path.join(__dirname, 'wrangler.toml');
const BINDING_NAME = 'DASHBOARD_STATE';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', cwd: __dirname }).trim();
}

function log(msg) {
  console.log(`\x1b[36m[setup]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[setup]\x1b[0m ${msg}`);
}

// ── Step 1: Ensure wrangler is available ──────────────────────────────────────

try {
  run('npx wrangler --version');
} catch {
  error('wrangler not found. Run: npm install');
  process.exit(1);
}

// ── Step 2: Check for existing KV namespace ──────────────────────────────────

log('Checking for existing KV namespaces...');

let kvId = null;

try {
  const listOutput = run('npx wrangler kv namespace list');
  const namespaces = JSON.parse(listOutput);
  const existing = namespaces.find(ns => ns.title.includes(BINDING_NAME));
  if (existing) {
    kvId = existing.id;
    log(`Found existing KV namespace: ${kvId}`);
  }
} catch {
  // list failed — might not be logged in, or no namespaces yet
}

// ── Step 3: Create KV namespace if needed ────────────────────────────────────

if (!kvId) {
  log('Creating KV namespace...');
  try {
    const createOutput = run(`npx wrangler kv namespace create ${BINDING_NAME}`);
    // Wrangler outputs something like: id = "abc123def456"
    const match = createOutput.match(/id\s*=\s*"([a-f0-9]+)"/);
    if (match) {
      kvId = match[1];
      log(`Created KV namespace: ${kvId}`);
    } else {
      error(`Could not parse KV namespace ID from wrangler output:\n${createOutput}`);
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to create KV namespace: ${err.message}`);
    process.exit(1);
  }
}

// ── Step 4: Patch wrangler.toml ──────────────────────────────────────────────

log('Updating wrangler.toml...');

let toml = fs.readFileSync(TOML_PATH, 'utf-8');

// Check if there's already an uncommented [[kv_namespaces]] block
if (/^\[\[kv_namespaces\]\]/m.test(toml)) {
  // Replace the existing id line
  toml = toml.replace(
    /^(id\s*=\s*)"[^"]*"/m,
    `$1"${kvId}"`
  );
} else {
  // Remove any commented-out KV block and add a real one
  toml = toml.replace(
    /# Create via:.*\n(#\s*\[\[kv_namespaces\]\]\n#\s*binding\s*=.*\n#\s*id\s*=.*\n)/m,
    `# Create via: npx wrangler kv namespace create ${BINDING_NAME}\n[[kv_namespaces]]\nbinding = "${BINDING_NAME}"\nid = "${kvId}"\n`
  );
}

fs.writeFileSync(TOML_PATH, toml);
log(`wrangler.toml updated with KV ID: ${kvId}`);

// ── Step 5: Deploy ───────────────────────────────────────────────────────────

log('Deploying worker...');
try {
  const deployOutput = run('npx wrangler deploy');
  console.log(deployOutput);
  log('Deploy complete!');
} catch (err) {
  error(`Deploy failed: ${err.message}`);
  process.exit(1);
}
