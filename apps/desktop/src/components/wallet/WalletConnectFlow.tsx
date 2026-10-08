import { shortAddress, t } from "@pewterdesk/ui";
import { create as createQr } from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { walletClient } from "../../api/venueClient";
import { addAccount } from "../../lib/account";
import {
  endSession,
  signTypedData,
  startPairing,
  type WalletSession,
} from "../../lib/walletConnect";
import { LogoMark } from "../header/AppLogo";

type Step =
  | { kind: "idle" }
  | { kind: "pairing"; uri?: string }
  | { kind: "signing"; address: string }
  | { kind: "sending" }
  | { kind: "error"; message: string };

/** A message to show for whatever was thrown: ours are Errors, WalletConnect's are `{ message }`. */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return t("error.failed");
}

/** The share of the code's width the logo's tile covers, in its centre. */
const LOGO_SHARE = 0.22;

/**
 * The QR code as one SVG path of its dark modules, coloured by CSS, with
 * the pewterdesk mark on a tile in its centre, both in the theme's own
 * colours like the header's logo. The tile hides the modules
 * under it, which the code's error correction (level Q, a quarter of it
 * recoverable) makes up for: the tile is about a twentieth of the area.
 */
export function QrCode({ value }: { value: string }) {
  const { size, path, tile } = useMemo(() => {
    const { modules } = createQr(value, { errorCorrectionLevel: "Q" });
    // A whole number of modules, the same parity as the code, so it sits dead centre.
    let side = Math.round(modules.size * LOGO_SHARE);
    if (side % 2 !== modules.size % 2) side += 1;
    const from = (modules.size - side) / 2;
    const under = (v: number) => v >= from && v < from + side;
    let d = "";
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(y, x) && !(under(x) && under(y))) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { size: modules.size, path: d, tile: { from, side } };
  }, [value]);
  return (
    <svg
      className="wallet-qr"
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      role="img"
      aria-label={t("wallet.wcScan")}
      shapeRendering="crispEdges"
    >
      <path d={path} fill="currentColor" />
      {/* The code stays black on white; the tile and the mark take the theme. */}
      <g shapeRendering="auto">
        <rect
          className="wallet-qr-tile"
          x={tile.from + 0.4}
          y={tile.from + 0.4}
          width={tile.side - 0.8}
          height={tile.side - 0.8}
          rx={tile.side * 0.2}
        />
        <LogoMark
          x={tile.from + tile.side * 0.14}
          y={tile.from + tile.side * 0.14}
          size={tile.side * 0.72}
        />
      </g>
    </svg>
  );
}

/**
 * Approving pewterdesk's API wallet from the user's own wallet: a QR code to
 * pair, then one signature. Rust makes the key and the approval and checks
 * the signature; this only shows the steps and carries the messages.
 * Closing the dialog (unmounting) abandons the attempt and its key.
 */
export function WalletConnectFlow() {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  // Bumped to abandon an attempt: its late results are ignored.
  const attempt = useRef(0);
  const session = useRef<WalletSession>(undefined);

  const abandon = () => {
    attempt.current++;
    void walletClient.cancelApproval().catch(() => undefined);
    if (session.current) void endSession(session.current).catch(() => undefined);
    session.current = undefined;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: abandons on unmount only
  useEffect(() => abandon, []);

  const start = async () => {
    const id = ++attempt.current;
    const alive = () => attempt.current === id;
    setCopied(false);
    setStep({ kind: "pairing" });
    try {
      const pairing = await startPairing();
      if (!alive()) return;
      setStep({ kind: "pairing", uri: pairing.uri });
      const connected = await pairing.session;
      if (!alive()) return;
      session.current = connected;
      setStep({ kind: "signing", address: connected.address });
      const typedData = await walletClient.beginApproval(
        "hyperliquid",
        connected.address,
        connected.chainId,
      );
      const signature = await signTypedData(connected, typedData);
      if (!alive()) return;
      setStep({ kind: "sending" });
      const info = await walletClient.finishApproval(signature);
      session.current = undefined;
      void endSession(connected).catch(() => undefined);
      addAccount(info.venue, info.address);
    } catch (e) {
      if (!alive()) return;
      abandon();
      setStep({ kind: "error", message: messageOf(e) });
    }
  };

  const cancel = () => {
    abandon();
    setStep({ kind: "idle" });
  };

  switch (step.kind) {
    case "idle":
      return (
        <div className="wallet-action">
          <button type="button" className="wallet-primary" onClick={start}>
            {t("wallet.wcStart")}
          </button>
        </div>
      );
    case "pairing":
      return (
        <div className="wallet-action">
          {step.uri ? <QrCode value={step.uri} /> : <div className="wallet-qr" aria-hidden />}
          <p className="wallet-note">{t(step.uri ? "wallet.wcScan" : "wallet.wcPreparing")}</p>
          <div className="wallet-actions">
            <button
              type="button"
              className="wallet-text"
              disabled={!step.uri}
              onClick={() => {
                if (!step.uri) return;
                void navigator.clipboard.writeText(step.uri).then(() => setCopied(true));
              }}
            >
              {t(copied ? "wallet.wcCopied" : "wallet.wcCopy")}
            </button>
            <button type="button" className="wallet-text" onClick={cancel}>
              {t("wallet.wcCancel")}
            </button>
          </div>
        </div>
      );
    case "signing":
      return (
        <div className="wallet-action">
          <div className="wallet-waiting">
            <span className="wallet-spinner" aria-hidden />
            <p>{t("wallet.wcSign", { address: shortAddress(step.address) })}</p>
          </div>
          <button type="button" className="wallet-text" onClick={cancel}>
            {t("wallet.wcCancel")}
          </button>
        </div>
      );
    case "sending":
      return (
        <div className="wallet-waiting">
          <span className="wallet-spinner" aria-hidden />
          <strong>{t("wallet.wcSending")}</strong>
        </div>
      );
    case "error":
      return (
        <div className="wallet-action">
          <p className="wallet-error" role="alert">
            {step.message}
          </p>
          <button type="button" className="wallet-primary" onClick={start}>
            {t("wallet.wcRetry")}
          </button>
        </div>
      );
  }
}
