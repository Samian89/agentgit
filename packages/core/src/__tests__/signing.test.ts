import { describe, expect, it } from "vitest";
import { generateKeyPair, signMessage, verifyMessage } from "../signing.js";

describe("Ed25519 signing", () => {
  it("generateKeyPair returns base64 32-byte seed and 32-byte point", () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(Buffer.from(privateKey, "base64").length).toBe(32);
    expect(Buffer.from(publicKey, "base64").length).toBe(32);
  });

  it("signMessage produces a signature that verifyMessage accepts", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const sig = signMessage("hello world", privateKey);
    expect(verifyMessage("hello world", sig, publicKey)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const sig = signMessage("hello world", privateKey);
    expect(verifyMessage("hello WORLD", sig, publicKey)).toBe(false);
  });

  it("rejects a signature produced by a different key", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = signMessage("payload", a.privateKey);
    expect(verifyMessage("payload", sig, b.publicKey)).toBe(false);
  });

  it("returns false for malformed signatures rather than throwing", () => {
    const { publicKey } = generateKeyPair();
    expect(verifyMessage("hello", "not-base64-or-wrong-length", publicKey)).toBe(
      false,
    );
  });
});
