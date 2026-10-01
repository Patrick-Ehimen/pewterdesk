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

/** Proposes a session asking only to sign typed data, on Arbitrum. */
export async function startPairing(): Promise<Pairing> {
  const c = await signClient();
  const { uri, approval } = await c.connect({
    optionalNamespaces: {
      eip155: {
        chains: [`eip155:${ARBITRUM_CHAIN_ID}`],
        methods: ["eth_signTypedData_v4"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  });
  if (!uri) throw new Error("WalletConnect gave no pairing link");
  const session = approval().then((s) => {
    const account = s.namespaces.eip155?.accounts.map(parseAccount).find((a) => a !== undefined);
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
