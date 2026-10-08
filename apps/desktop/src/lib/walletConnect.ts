import type { VenueId } from "@pewterdesk/core";
import type SignClient from "@walletconnect/sign-client";

// WalletConnect, for approving pewterdesk's API wallet from the user's own
// wallet (phone or browser extension). This module only carries messages:
// Rust generates the agent key and builds the approval (wallet.rs), the
// wallet signs it, and Rust checks and sends it. No key passes through here.
//
// The webview's CSP allows WalletConnect's relay for this; venue traffic
// still never leaves Rust.

/** Reown (WalletConnect) cloud project. Public: it identifies the app, it isn't a secret. */
export const WALLETCONNECT_PROJECT_ID = "04474a9ae1a19220f85b7c4165631bd9";

/** Arbitrum One: where Hyperliquid's own site has wallets sign. */
export const ARBITRUM_CHAIN_ID = 42161;
/**
 * The chain a venue's API wallet approval is asked to be signed on. Both
 * venues take any chain, and Arbitrum is one nearly every wallet has.
 */
export const approvalChain = (_venue: VenueId) => ARBITRUM_CHAIN_ID;

let client: Promise<SignClient> | undefined;

/** The sign client, loaded and started on first use (it's large, and most sessions never need it). */
function signClient(): Promise<SignClient> {
  client ??= import("@walletconnect/sign-client")
    .then(({ SignClient }) =>
      SignClient.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        telemetryEnabled: false,
        metadata: {
          name: "pewterdesk",
          description: "Non-custodial crypto derivatives trading terminal",
          url: "https://github.com/Patrick-Ehimen/pewterdesk",
          icons: [],
        },
      }),
    )
    .catch((e: unknown) => {
      // A failed start can be retried.
      client = undefined;
      throw e;
    });
  return client;
}

export interface WalletSession {
  topic: string;
  /** Lowercase 0x address. */
  address: string;
  chainId: number;
}

/** Reads `eip155:<chain>:<address>`, the CAIP-10 form sessions list accounts in. */
export function parseAccount(account: string): { address: string; chainId: number } | undefined {
  const match = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(account);
  if (!match) return undefined;
  return { chainId: Number(match[1]), address: (match[2] as string).toLowerCase() };
}

export interface Pairing {
  /** The `wc:` link the QR code shows. */
  uri: string;
  /** Settles when the wallet approves the connection (or rejects it). */
  session: Promise<WalletSession>;
}

/** Proposes a session asking only to sign typed data, on `chainId`. */
export async function startPairing(chainId: number): Promise<Pairing> {
  const c = await signClient();
  const { uri, approval } = await c.connect({
    optionalNamespaces: {
      eip155: {
        chains: [`eip155:${chainId}`],
        methods: ["eth_signTypedData_v4"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  });
  if (!uri) throw new Error("WalletConnect gave no pairing link");
  const session = approval().then((s) => {
    const accounts = (s.namespaces.eip155?.accounts ?? [])
      .map(parseAccount)
      .filter((a) => a !== undefined);
    // The one on the chain asked for, where the wallet shares several.
    const account = accounts.find((a) => a.chainId === chainId) ?? accounts[0];
    if (!account) throw new Error("the wallet shared no Ethereum account");
    return { topic: s.topic, ...account };
  });
  return { uri, session };
}

/** Asks the wallet to sign `typedData` (built by Rust) as `address`. */
export async function signTypedData(session: WalletSession, typedData: unknown): Promise<string> {
  const c = await signClient();
  return c.request<string>({
    topic: session.topic,
    chainId: `eip155:${session.chainId}`,
    request: {
      method: "eth_signTypedData_v4",
      params: [session.address, JSON.stringify(typedData)],
    },
  });
}

/** Ends the session: once the approval is through, the wallet isn't needed. */
export async function endSession(session: WalletSession): Promise<void> {
  const c = await signClient();
  await c.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: "User disconnected." },
  });
}
