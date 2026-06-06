/**
 * Custodial wallet manager for kickoff — EVM edition.
 *
 * Adapted from the APEX AWS KMS envelope-encryption pattern (Hedera/Ed25519)
 * to Monad/EVM (secp256k1, ethers). Each Telegram user gets a dedicated wallet
 * whose private key is encrypted at rest and only decrypted in-memory to sign.
 *
 * Encryption strategy (in priority order):
 *   1. AWS KMS — one master symmetric key; the 32-byte wallet key is encrypted
 *      directly via KMS Encrypt with an EncryptionContext (same as APEX).
 *   2. Local AES-256-GCM — fallback if AWS is unconfigured/unreachable, so the
 *      live demo never depends on venue wifi. Master secret from
 *      WALLET_MASTER_SECRET or auto-generated and saved locally.
 *
 * Storage: deploy/wallets.json maps telegramUserId -> { address, enc:{...} }.
 * Plaintext keys are NEVER written to disk.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const DEPLOY_DIR = path.join(__dirname, "..", "deploy");
const WALLET_FILE = path.join(DEPLOY_DIR, "wallets.json");
const KMS_FILE = path.join(DEPLOY_DIR, "kms.json");
const LOCAL_KEY_FILE = path.join(DEPLOY_DIR, "local-master.key");

const ENC_CONTEXT = { platform: "kickoff", keyType: "evm-secp256k1" };

let _mode = null; // "kms" | "local"
let _kms = null;
let _kmsKeyId = null;
let _localKey = null; // 32-byte Buffer
let _store = null;

function ensureDir() {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
}

function loadStore() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  } catch (_) {
    _store = {};
  }
  return _store;
}

function saveStore() {
  ensureDir();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(_store, null, 2));
}

// ── Init: choose KMS or local ──────────────────────────────────────────────
async function init() {
  if (_mode) return _mode;
  ensureDir();

  const haveAws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  if (haveAws && process.env.WALLET_USE_LOCAL !== "1") {
    try {
      await initKms();
      _mode = "kms";
      console.log(`[wallets] mode=KMS keyId=${_kmsKeyId}`);
      return _mode;
    } catch (e) {
      console.warn("[wallets] KMS init failed, falling back to local AES:", e.message);
    }
  }
  initLocal();
  _mode = "local";
  console.log("[wallets] mode=LOCAL AES-256-GCM");
  return _mode;
}

async function initKms() {
  const {
    KMSClient,
    CreateKeyCommand,
    EncryptCommand,
    DecryptCommand,
  } = require("@aws-sdk/client-kms");
  _kms = new KMSClient({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  _kms._cmds = { EncryptCommand, DecryptCommand };

  // Resolve the master key id: env -> saved file -> create new.
  _kmsKeyId = process.env.KMS_KEY_ID || null;
  if (!_kmsKeyId) {
    try {
      _kmsKeyId = JSON.parse(fs.readFileSync(KMS_FILE, "utf8")).keyId;
    } catch (_) {}
  }
  if (!_kmsKeyId) {
    const res = await _kms.send(
      new CreateKeyCommand({
        Description: "kickoff master wallet-encryption key",
        KeyUsage: "ENCRYPT_DECRYPT",
        KeySpec: "SYMMETRIC_DEFAULT",
        Tags: [{ TagKey: "Platform", TagValue: "kickoff" }],
      })
    );
    _kmsKeyId = res.KeyMetadata?.KeyId;
    if (!_kmsKeyId) throw new Error("CreateKey returned no KeyId");
    fs.writeFileSync(KMS_FILE, JSON.stringify({ keyId: _kmsKeyId }, null, 2));
  }
  // Sanity round-trip to confirm encrypt/decrypt actually work with these creds.
  const probe = await kmsEncrypt(Buffer.from("kickoff-probe"));
  const back = await kmsDecrypt(probe);
  if (back.toString() !== "kickoff-probe") throw new Error("KMS round-trip mismatch");
}

function initLocal() {
  let secret = process.env.WALLET_MASTER_SECRET;
  if (!secret) {
    try {
      secret = fs.readFileSync(LOCAL_KEY_FILE, "utf8").trim();
    } catch (_) {
      secret = crypto.randomBytes(32).toString("hex");
      ensureDir();
      fs.writeFileSync(LOCAL_KEY_FILE, secret, { mode: 0o600 });
    }
  }
  _localKey = crypto.createHash("sha256").update(String(secret)).digest(); // 32 bytes
}

// ── KMS primitives ─────────────────────────────────────────────────────────
async function kmsEncrypt(buf) {
  const { EncryptCommand } = _kms._cmds;
  const r = await _kms.send(
    new EncryptCommand({ KeyId: _kmsKeyId, Plaintext: buf, EncryptionContext: ENC_CONTEXT })
  );
  return Buffer.from(r.CiphertextBlob);
}
async function kmsDecrypt(ciphertextBuf) {
  const { DecryptCommand } = _kms._cmds;
  const r = await _kms.send(
    new DecryptCommand({
      KeyId: _kmsKeyId,
      CiphertextBlob: ciphertextBuf,
      EncryptionContext: ENC_CONTEXT,
    })
  );
  return Buffer.from(r.Plaintext);
}

// ── Local AES-256-GCM primitives ───────────────────────────────────────────
function localEncrypt(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _localKey, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]); // iv(12) | tag(16) | ct
}
function localDecrypt(blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", _localKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── Encrypt/decrypt a wallet private key ───────────────────────────────────
async function encryptKey(privHex) {
  const raw = Buffer.from(privHex.replace(/^0x/, ""), "hex"); // 32 bytes
  let record;
  if (_mode === "kms") {
    record = { method: "kms", keyId: _kmsKeyId, blob: (await kmsEncrypt(raw)).toString("base64") };
  } else {
    record = { method: "local", blob: localEncrypt(raw).toString("base64") };
  }
  raw.fill(0);
  return record;
}

async function decryptKey(enc) {
  const blob = Buffer.from(enc.blob, "base64");
  let raw;
  if (enc.method === "kms") {
    raw = await kmsDecrypt(blob);
  } else {
    raw = localDecrypt(blob);
  }
  const hex = "0x" + Buffer.from(raw).toString("hex");
  Buffer.from(raw).fill(0);
  return hex;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Create the wallet for a user if missing; returns { address, isNew }. */
async function getOrCreateWallet(userId) {
  await init();
  const store = loadStore();
  const key = String(userId);
  if (store[key]) return { address: store[key].address, isNew: false };

  const w = ethers.Wallet.createRandom();
  const enc = await encryptKey(w.privateKey);
  store[key] = { address: w.address, enc, createdAt: new Date().toISOString() };
  saveStore();
  return { address: w.address, isNew: true };
}

/** Return a connected ethers signer for the user (key decrypted in-memory). */
async function getSigner(userId, provider) {
  await init();
  const store = loadStore();
  const rec = store[String(userId)];
  if (!rec) throw new Error(`no wallet for user ${userId}`);
  const pk = await decryptKey(rec.enc);
  return new ethers.Wallet(pk, provider);
}

function getAddress(userId) {
  const store = loadStore();
  return store[String(userId)]?.address || null;
}

function listWallets() {
  const store = loadStore();
  return Object.entries(store).map(([userId, v]) => ({ userId, address: v.address }));
}

async function mode() {
  await init();
  return _mode;
}

module.exports = { getOrCreateWallet, getSigner, getAddress, listWallets, mode };
