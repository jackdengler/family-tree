#!/usr/bin/env node
/*
 * encrypt-data.mjs — encrypt the family data for the static archive.
 *
 * Reads a plaintext JSON file (the FAMILY_DATA object) and writes, to stdout,
 * js/data.enc.js assigning window.FAMILY_DATA_ENC with AES-256-GCM ciphertext.
 * Uses only Node 22 built-ins (node:crypto webcrypto) — no dependencies.
 *
 * Usage:
 *   node tools/encrypt-data.mjs <plaintext-data.json> <passphrase>  > js/data.enc.js
 *   FAMILY_KEY=... node tools/encrypt-data.mjs <plaintext-data.json> > js/data.enc.js
 *
 * The passphrase is read from FAMILY_KEY if set (keeps it out of shell history),
 * otherwise from the 2nd CLI argument. It is never written to the output.
 */
import { webcrypto as crypto } from "node:crypto";
import { readFileSync } from "node:fs";

const ITERATIONS = 310000;

function fail(msg) {
  process.stderr.write("encrypt-data: " + msg + "\n");
  process.exit(1);
}

const fileArg = process.argv[2];
const passArg = process.argv[3];
const passphrase = process.env.FAMILY_KEY || passArg;

if (!fileArg) fail("missing <plaintext-data.json> argument");
if (!passphrase) fail("missing passphrase (pass as 2nd arg or FAMILY_KEY env var)");

let plaintext;
try {
  plaintext = readFileSync(fileArg, "utf8");
} catch (e) {
  fail("cannot read " + fileArg + ": " + e.message);
}

// Validate it is well-formed JSON before encrypting.
try {
  JSON.parse(plaintext);
} catch (e) {
  fail("input is not valid JSON: " + e.message);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));

const baseKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(passphrase),
  "PBKDF2",
  false,
  ["deriveKey"]
);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  baseKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"]
);
const ctBuf = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  key,
  new TextEncoder().encode(plaintext)
);

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const payload = {
  v: 1,
  kdf: "PBKDF2-SHA256",
  iter: ITERATIONS,
  salt: b64(salt),
  iv: b64(iv),
  ct: b64(new Uint8Array(ctBuf))
};

process.stdout.write(
  "// GENERATED FILE — encrypted family data (AES-256-GCM). Do not edit by hand.\n" +
  "// Regenerate: node tools/encrypt-data.mjs <plaintext-data.json> <passphrase> > js/data.enc.js\n" +
  "// The passphrase is NEVER stored here; only ciphertext, salt and IV are.\n" +
  "window.FAMILY_DATA_ENC = " + JSON.stringify(payload) + ";\n"
);
