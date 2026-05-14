import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Ed25519 helpers used to sign commit hashes when signing is enabled in
 * .agentgit/config.json.
 *
 * Keys are stored in config as base64-encoded raw 32-byte values, which is the
 * format ssh and most Ed25519 libraries use. Node's `crypto` works with DER /
 * PEM internally so these helpers convert between the two.
 */

const PRIVATE_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Ed25519KeyPair {
  /** Base64 encoded raw 32-byte seed. */
  privateKey: string;
  /** Base64 encoded raw 32-byte public key. */
  publicKey: string;
}

export function generateKeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  // PKCS#8 Ed25519 keys are 48 bytes: 16-byte prefix + 32-byte seed.
  // SPKI Ed25519 keys are 44 bytes: 12-byte prefix + 32-byte point.
  const seed = privDer.subarray(privDer.length - 32);
  const point = pubDer.subarray(pubDer.length - 32);
  return {
    privateKey: seed.toString("base64"),
    publicKey: point.toString("base64"),
  };
}

function privateKeyFromBase64(b64: string) {
  const seed = Buffer.from(b64, "base64");
  if (seed.length !== 32) {
    throw new Error(
      `Ed25519 private key must decode to 32 bytes, got ${seed.length}`,
    );
  }
  return createPrivateKey({
    key: Buffer.concat([PRIVATE_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromBase64(b64: string) {
  const point = Buffer.from(b64, "base64");
  if (point.length !== 32) {
    throw new Error(
      `Ed25519 public key must decode to 32 bytes, got ${point.length}`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([PUBLIC_PREFIX, point]),
    format: "der",
    type: "spki",
  });
}

/**
 * Sign a message (e.g. a commit hash hex string) with a raw base64 Ed25519
 * private key and return the signature as base64.
 */
export function signMessage(message: string, privateKeyB64: string): string {
  const key = privateKeyFromBase64(privateKeyB64);
  const sig = sign(null, Buffer.from(message, "utf8"), key);
  return sig.toString("base64");
}

/**
 * Verify a base64 signature against a message and base64 public key. Returns
 * false for tampered signatures, mismatched keys, or malformed inputs.
 */
export function verifyMessage(
  message: string,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    const key = publicKeyFromBase64(publicKeyB64);
    return verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
