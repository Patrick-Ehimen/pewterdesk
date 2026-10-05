import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  FaFacebookF,
  FaInstagram,
  FaLine,
  FaLinkedinIn,
  FaRedditAlien,
  FaTelegram,
  FaWhatsapp,
  FaXTwitter,
} from "react-icons/fa6";
import {
  LuChevronLeft,
  LuChevronRight,
  LuCopy,
  LuDownload,
  LuRectangleHorizontal,
  LuRectangleVertical,
  LuX,
} from "react-icons/lu";
import { t } from "../../i18n";
import {
  drawShareCard,
  loadImage,
  SHARE_SIZE,
  type ShareCard,
  type ShareLayout,
  type ShareSlide,
} from "../../lib/shareCard";

/**
 * How large the preview shows each layout, against its drawn size. Chosen so
 * both come out in whole pixels (576x342, 342x450): a fractional size makes
 * the browser stretch the canvas, which blurs its text.
 */
const PREVIEW: Record<ShareLayout, number> = { landscape: 0.9, portrait: 0.9 };
/** The saved and copied image's pixel density. */
const EXPORT_SCALE = 3;

import { toast, toastError } from "../../lib/toasts";
import { Switch } from "../common/Switch";

/** The sites a card can be shared to, in the order their buttons show. */
export const SHARE_TARGETS = [
  "x",
  "whatsapp",
  "telegram",
  "facebook",
  "instagram",
  "linkedin",
  "reddit",
  "line",
] as const;
export type ShareTarget = (typeof SHARE_TARGETS)[number];

/** Each site's name (a brand, the same in every language) and mark. */
const SITE: Record<ShareTarget, { name: string; icon: ReactNode }> = {
  x: { name: "X", icon: <FaXTwitter size={18} aria-hidden /> },
  whatsapp: { name: "WhatsApp", icon: <FaWhatsapp size={20} aria-hidden /> },
  telegram: { name: "Telegram", icon: <FaTelegram size={19} aria-hidden /> },
  facebook: { name: "Facebook", icon: <FaFacebookF size={18} aria-hidden /> },
  instagram: { name: "Instagram", icon: <FaInstagram size={19} aria-hidden /> },
  linkedin: { name: "LinkedIn", icon: <FaLinkedinIn size={18} aria-hidden /> },
  reddit: { name: "Reddit", icon: <FaRedditAlien size={19} aria-hidden /> },
  line: { name: "LINE", icon: <FaLine size={19} aria-hidden /> },
};

/**
 * Sharing a trade's P&L as an image: a card with the PewterDesk mark and
 * the venue, the market and side, and either the ROI or the PnL (two
 * slides), landscape or portrait. On a demo account it says so, unless the
 * user turns that off. The card can be copied, saved, or shared to a social
 * site: the image is copied and the site's post page opens with the caption,
 * for the user to paste it into. Nothing goes anywhere unless they post it.
 */
export function PnlShareDialog({
  card,
  demo,
  onSave,
  onShare,
  onClose,
}: {
  /** The card, without its demo badge: that's this dialog's to add. */
  card: Omit<ShareCard, "demoLabel">;
  /** A demo account's trade: the card says "Demo" unless turned off. */
  demo: boolean;
  /** Saves the PNG; resolves to where it went. */
  onSave: (png: Blob) => Promise<string>;
  /** Opens a site's post page with the caption; without it, no share buttons. */
  onShare?: (target: ShareTarget, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slides: ShareSlide[] = card.roi ? ["roi", "pnl"] : ["pnl"];
  const [slide, setSlide] = useState(0);
  const [layout, setLayout] = useState<ShareLayout>("landscape");
  const [showDemo, setShowDemo] = useState(true);
  const [images, setImages] = useState<{ brand?: HTMLImageElement; venue?: HTMLImageElement }>();
  const captionId = useId();
  const headline = card.roi ?? card.pnl;
  const [caption, setCaption] = useState(() =>
    t("share.text", {
      market: card.market,
      side: card.position.value,
      figure: `${headline.value} ${headline.short}`,
      venue: card.venue,
    }),
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([loadImage(card.brandLogo), loadImage(card.venueLogo)]).then(([brand, venue]) => {
      if (live) setImages({ brand, venue });
    });
    return () => {
      live = false;
    };
  }, [card.brandLogo, card.venueLogo]);

  const current = slides[Math.min(slide, slides.length - 1)] ?? "pnl";
  const shown = { ...card, demoLabel: demo && showDemo ? t("share.demo") : undefined };
  const size = SHARE_SIZE[layout];
  // Drawn at exactly the screen's density for the size it shows at, so the
  // browser never resamples it (which is what blurs canvas text).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` is rebuilt from these each render
  useEffect(() => {
    if (!canvasRef.current || !images) return;
    const density = (window.devicePixelRatio || 1) * PREVIEW[layout];
    drawShareCard(canvasRef.current, shown, images, current, layout, density);
  }, [card, demo, showDemo, images, current, layout]);

  // The saved image is its own, sharper render.
  const png = () =>
    new Promise<Blob>((resolve, reject) => {
      if (!images) return reject(new Error("no image"));
      const out = document.createElement("canvas");
      drawShareCard(out, shown, images, current, layout, EXPORT_SCALE);
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
  // The image goes on the clipboard first (started inside the click, as
  // WebKit requires), then the site opens for it to be pasted in.
  const share = async (target: ShareTarget) => {
    if (!onShare) return;
    const copied = navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]).then(
      () => true,
      () => false,
    );
    try {
      await onShare(target, caption);
      toast({
        title: t("share.title"),
        body: (await copied)
          ? t("share.pasteImage", { site: SITE[target].name })
          : t("share.noImage", { site: SITE[target].name }),
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

  return (
    <dialog
      ref={dialogRef}
      className="pd-share"
      aria-labelledby="pd-share-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="pd-share-head">
        <h3 id="pd-share-title">{t("share.title")}</h3>
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
        <div className="pd-share-main">
          <div className="pd-share-stage">
            {slides.length > 1 && (
              <button
                type="button"
                className="pd-share-arrow"
                aria-label={t("share.prev")}
                onClick={() => setSlide((s) => (s + slides.length - 1) % slides.length)}
              >
                <LuChevronLeft size={18} aria-hidden />
              </button>
            )}
            <canvas
              ref={canvasRef}
              className="pd-share-canvas"
              data-layout={layout}
              style={{ width: size.w * PREVIEW[layout], height: size.h * PREVIEW[layout] }}
              role="img"
              aria-label={`${card.market} ${current === "roi" && card.roi ? card.roi.value : card.pnl.value}`}
            />
            {slides.length > 1 && (
              <button
                type="button"
                className="pd-share-arrow"
                aria-label={t("share.next")}
                onClick={() => setSlide((s) => (s + 1) % slides.length)}
              >
                <LuChevronRight size={18} aria-hidden />
              </button>
            )}
          </div>
          <div className="pd-share-under">
            <div className="pd-share-dots" aria-hidden>
              {slides.map((s, i) => (
                <span key={s} className="pd-share-dot" data-on={i === slide || undefined} />
              ))}
            </div>
            <div className="pd-share-layouts" role="radiogroup" aria-label={t("share.layout")}>
              {(["landscape", "portrait"] as const).map((l) => (
                // biome-ignore lint/a11y/useSemanticElements: a two-way icon toggle
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={layout === l}
                  aria-label={t(l === "landscape" ? "share.landscape" : "share.portrait")}
                  onClick={() => setLayout(l)}
                >
                  {l === "landscape" ? (
                    <LuRectangleHorizontal size={16} aria-hidden />
                  ) : (
                    <LuRectangleVertical size={16} aria-hidden />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {onShare && (
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
                  <button
                    type="button"
                    className="pd-share-site"
                    onClick={() => void share(target)}
                  >
                    <span className="pd-share-site-mark">{SITE[target].icon}</span>
                    {SITE[target].name}
                  </button>
                </li>
              ))}
            </ul>
            <p className="pd-share-hint">{t("share.hint")}</p>
          </aside>
        )}
      </div>

      <footer className="pd-share-foot">
        {demo && (
          <span className="pd-share-toggle">
            <Switch checked={showDemo} onChange={setShowDemo} label={t("share.showDemo")} />
            {t("share.showDemo")}
          </span>
        )}
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
