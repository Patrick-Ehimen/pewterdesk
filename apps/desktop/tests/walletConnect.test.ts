import { describe, expect, it } from "vitest";
import { parseAccount } from "../src/lib/walletConnect";

describe("WalletConnect accounts", () => {
  it("reads CAIP-10 accounts", () => {
    expect(parseAccount("eip155:42161:0xAbCdEf0123456789abcdef0123456789ABCDEF01")).toEqual({
      chainId: 42161,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
  });

  it("ignores what isn't an Ethereum account", () => {
    expect(parseAccount("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:abc")).toBeUndefined();
    expect(parseAccount("eip155:1:0x123")).toBeUndefined();
    expect(parseAccount("")).toBeUndefined();
  });
});
