import {
  loadImage,
  SHARE_SITES,
  SHARE_TARGETS,
  type ShareTarget,
  sharePalette,
  t,
  toast,
  toastError,
} from "@pewterdesk/ui";
import { useEffect, useId, useRef, useState } from "react";
import { LuCopy, LuDownload, LuX } from "react-icons/lu";
import {
  AI_CARD_EXPORT_SCALE,
  AI_CARD_WIDTH,
  type AiShareCard,
  drawAiShareCard,
} from "../../lib/aiShareCard";

/** The preview's width on screen, in CSS pixels. */
const PREVIEW_WIDTH = 520;

/**
 * Sharing an answer as an image, as the P&L card is shared: copied, saved,
 * or put on a social site's post page with a caption (the image goes by
 * the clipboard, for the trader to paste). Nothing is posted for them.
 */
export function AiShareDialog({
  card,
  brandLogo,
  onSave,
  onShare,
  onClose,
}: {
  card: AiShareCard;
  brandLogo: string;
  /** Saves the PNG; resolves to where it went. */
  onSave: (png: Blob) => Promise<string>;
  /** Opens a site's post page with the caption. */
  onShare: (target: ShareTarget, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionId = useId();
  const [brand, setBrand] = useState<HTMLImageElement | null>();
  const [height, setHeight] = useState(0);
  const [caption, setCaption] = useState(() => t("ai.share.caption", { question: card.question }));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    loadImage(brandLogo).then((img) => live && setBrand(img ?? null));
    return () => {
      live = false;
    };
  }, [brandLogo]);
  useEffect(() => {
    if (!canvasRef.current || brand === undefined) return;
    const scale = (window.devicePixelRatio || 1) * (PREVIEW_WIDTH / AI_CARD_WIDTH);
    setHeight(drawAiShareCard(canvasRef.current, card, sharePalette(), brand ?? undefined, scale));
  }, [card, brand]);

  const png = () =>
    new Promise<Blob>((resolve, reject) => {
      const out = document.createElement("canvas");
      drawAiShareCard(out, card, sharePalette(), brand ?? undefined, AI_CARD_EXPORT_SCALE);
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png");
    });
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
      toast({ title: t("share.title"), body: t("share.copied") });
    } catch {
      toast({ title: t("share.title"), body: t("share.failed"), tone: "warn" });
    }
  };
  const share = async (target: ShareTarget) => {
    // The image goes on the clipboard first (inside the click, as WebKit requires).
    const copied = navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]).then(
      () => true,
      () => false,
    );
    try {
      await onShare(target, caption);
      toast({
        title: t("share.title"),
        body: (await copied)
          ? t("share.pasteImage", { site: SHARE_SITES[target].name })
          : t("share.noImage", { site: SHARE_SITES[target].name }),
      });
    } catch (err) {
      toastError(t("share.title"), err, t("share.failed"));
    }
  };
  const save = async () => {
    try {
      const path = await onSave(await png());
      toast({ title: t("share.title"), body: t("share.saved", { path }) });
    } catch (err) {
      toastError(t("share.title"), err, t("share.failed"));
    }
  };

  const scale = PREVIEW_WIDTH / AI_CARD_WIDTH;
  return (
    <dialog
      ref={dialogRef}
      className="pd-share ai-share"
      aria-labelledby="ai-share-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="pd-share-head">
        <h3 id="ai-share-title">{t("ai.share.title")}</h3>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={18} aria-hidden />
        </button>
      </header>
      <div className="pd-share-body">
        <div className="pd-share-main ai-share-main">
          <canvas
            ref={canvasRef}
            className="ai-share-canvas"
            style={{ width: PREVIEW_WIDTH, height: height * scale }}
            role="img"
            aria-label={card.question}
          />
        </div>
        <aside className="pd-share-side">
          <label className="pd-share-label" htmlFor={captionId}>
            {t("share.caption")}
          </label>
          <textarea
            id={captionId}
            className="pd-share-caption"
            value={caption}
            maxLength={500}
            rows={4}
            onChange={(e) => setCaption(e.target.value)}
          />
          <span className="pd-share-label">{t("share.to")}</span>
          <ul className="pd-share-sites">
            {SHARE_TARGETS.map((target) => (
              <li key={target}>
                <button type="button" className="pd-share-site" onClick={() => void share(target)}>
                  <span className="pd-share-site-mark">{SHARE_SITES[target].icon}</span>
                  {SHARE_SITES[target].name}
                </button>
              </li>
            ))}
          </ul>
          <p className="pd-share-hint">{t("share.hint")}</p>
        </aside>
      </div>
      <footer className="pd-share-foot">
        <span />
        <span className="pd-share-actions">
          <button type="button" className="pd-share-action" onClick={() => void copy()}>
            <LuCopy size={16} aria-hidden />
            {t("share.copy")}
          </button>
          <button
            type="button"
            className="pd-share-action"
            data-primary
            onClick={() => void save()}
          >
            <LuDownload size={16} aria-hidden />
            {t("share.save")}
          </button>
        </span>
      </footer>
    </dialog>
  );
}
