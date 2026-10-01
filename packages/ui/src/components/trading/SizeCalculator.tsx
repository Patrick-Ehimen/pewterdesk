import type { Market } from "@pewterdesk/core";
import { type ReactNode, useEffect, useId, useState } from "react";
import { LuCalculator, LuChevronDown } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { liquidationPrice, maxOpen, targetPrice, tradePnl } from "../../lib/calculator";
import {
  decimalsOf,
  formatNumber,
  formatPercent,
  formatSigned,
  trendClass,
} from "../../lib/format";
import type { TicketSide } from "../../lib/ticket";
import { Hint } from "../common/ColumnHeader";
import { Tooltip } from "../common/Tooltip";
import { NumberField } from "./TicketField";

type CalcTab = "pnl" | "target" | "liq" | "maxOpen";
const TABS: readonly { id: CalcTab; label: MessageKey }[] = [
  { id: "pnl", label: "calc.pnl" },
  { id: "target", label: "calc.target" },
  { id: "liq", label: "calc.liq" },
  { id: "maxOpen", label: "calc.maxOpen" },
];

function Line({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pd-ticket-line">
      <dt>
        {hint ? (
          <Tooltip className="pd-ticket-hint" content={<Hint title={label}>{hint}</Hint>}>
            {label}
          </Tooltip>
        ) : (
          label
        )}
      </dt>
      {children}
    </div>
  );
}

/**
 * The order ticket's calculator, folded away until opened, after the one
 * on most exchanges: pick a tab, long or short and a leverage, and it works
 * out the PnL of a trade, the price for a target ROI, the liquidation
 * price, or the most a balance can open (which "Use this size" copies into
 * the ticket). Entry is the mid unless typed.
 */
export function SizeCalculator({
  market,
  mid,
  takerFee,
  side: ticketSide,
  leverage: ticketLeverage,
  available,
  onUse,
}: {
  market?: Market;
  /** The book's mid, the entry when none is typed. */
  mid: number;
  /** Unset where the ticket doesn't know the fees; they're then left out. */
  takerFee?: number;
  /** The ticket's side and leverage, the calculator's starting point. */
  side: TicketSide;
  leverage: number;
  /** The connected account's free margin, used when no balance is typed. */
  available?: number;
  onUse: (size: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CalcTab>("pnl");
  const [side, setSide] = useState<TicketSide>(ticketSide);
  const [leverage, setLeverage] = useState(String(ticketLeverage));
  const [entry, setEntry] = useState("");
  const [exit, setExit] = useState("");
  const [size, setSize] = useState("");
  const [roi, setRoi] = useState("");
  const [balance, setBalance] = useState("");
  const bodyId = useId();

  // Opening it starts from the ticket's side and leverage.
  // biome-ignore lint/correctness/useExhaustiveDependencies: copies the ticket's values on open only
  useEffect(() => {
    if (!open) return;
    setSide(ticketSide);
    setLeverage(String(ticketLeverage));
  }, [open]);
  // Prices and sizes belong to one market.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on the market's id only
  useEffect(() => {
    for (const reset of [setEntry, setExit, setSize]) reset("");
  }, [market?.id]);

  const quote = market?.quote ?? "USDC";
  const base = market?.base ?? "";
  const maxLeverage = market?.maxLeverage ?? 0;
  const priceDecimals = decimalsOf(market?.tickSize ?? "0.01");
  const sizeDecimals = decimalsOf(market?.sizeStep ?? "0");
  const lev = Number(leverage);
  const entryPrice = Number(entry) > 0 ? Number(entry) : mid;
  const fee = takerFee ?? 0;

  const pnl = tradePnl(side, lev, entryPrice, Number(exit), Number(size), fee);
  const target = targetPrice(side, lev, entryPrice, roi === "" ? Number.NaN : Number(roi));
  const liq = liquidationPrice(side, lev, entryPrice, maxLeverage);
  const most = market
    ? maxOpen(
        balance !== "" ? Number(balance) : (available ?? 0),
        lev,
        entryPrice,
        market.sizeStep,
        fee,
      )
    : undefined;

  const money = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? "-" : `${formatNumber(v, 2)} ${quote}`;
  const price = (v: number | undefined) => (v === undefined ? "-" : formatNumber(v, priceDecimals));
  const tooMuch = maxLeverage > 0 && lev > maxLeverage;
  const entryField = (
    <NumberField
      label={t("calc.entry")}
      value={entry}
      onChange={setEntry}
      placeholder={mid > 0 ? mid.toFixed(priceDecimals) : undefined}
    />
  );

  return (
    <div className="pd-calc">
      <button
        type="button"
        className="pd-calc-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pd-calc-title">
          <LuCalculator size={14} aria-hidden />
          {t("calc.title")}
        </span>
        <LuChevronDown size={14} aria-hidden data-open={open || undefined} />
      </button>
      {open && (
        <div id={bodyId} className="pd-calc-body">
          <div className="pd-calc-tabs" role="tablist" aria-label={t("calc.tabs")}>
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {t(label)}
              </button>
            ))}
          </div>

          {/* Max Open doesn't depend on the direction, so leverage takes the row. */}
          <div className={tab === "maxOpen" ? "pd-calc-row" : "pd-ticket-row"}>
            {tab === "maxOpen" ? null : (
              <div className="pd-calc-sides" role="radiogroup" aria-label={t("calc.side")}>
                {(["buy", "sell"] as const).map((s) => (
                  // biome-ignore lint/a11y/useSemanticElements: two-way segmented switch, like the ticket's
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={side === s}
                    data-side={s}
                    onClick={() => setSide(s)}
                  >
                    {t(s === "buy" ? "calc.long" : "calc.short")}
                  </button>
                ))}
              </div>
            )}
            <NumberField
              label={t("calc.leverage")}
              value={leverage}
              onChange={setLeverage}
              suffix={<span className="pd-calc-unit">x</span>}
            />
          </div>

          {tab === "pnl" && (
            <>
              <div className="pd-ticket-row">
                {entryField}
                <NumberField label={t("calc.exit")} value={exit} onChange={setExit} />
              </div>
              <NumberField
                label={t("calc.size")}
                value={size}
                onChange={setSize}
                suffix={<span className="pd-calc-unit">{base}</span>}
              />
            </>
          )}
          {tab === "target" && (
            <div className="pd-ticket-row">
              {entryField}
              <NumberField
                label={t("calc.roi")}
                value={roi}
                onChange={setRoi}
                suffix={<span className="pd-calc-unit">%</span>}
              />
            </div>
          )}
          {tab === "liq" && entryField}
          {tab === "maxOpen" && (
            <div className="pd-ticket-row">
              {entryField}
              <NumberField
                label={t("calc.balance")}
                value={balance}
                onChange={setBalance}
                placeholder={available !== undefined ? available.toFixed(2) : undefined}
              />
            </div>
          )}

          <dl className="pd-ticket-summary pd-calc-result">
            {tab === "pnl" && (
              <>
                <Line label={t("calc.margin")}>
                  <dd>{money(pnl?.margin)}</dd>
                </Line>
                <Line label={t("calc.pnl")}>
                  <dd className={trendClass(pnl?.pnl ?? 0)}>
                    {pnl ? `${formatSigned(pnl.pnl, 2)} ${quote}` : "-"}
                  </dd>
                </Line>
                <Line label={t("calc.roi")}>
                  <dd className={trendClass(pnl?.roi ?? 0)}>
                    {pnl ? `${pnl.roi > 0 ? "+" : ""}${formatPercent(pnl.roi)}` : "-"}
                  </dd>
                </Line>
                <Line
                  label={t("calc.fees")}
                  hint={t(takerFee === undefined ? "calc.feesUnknown" : "calc.feesHint")}
                >
                  <dd>{money(pnl?.fees)}</dd>
                </Line>
              </>
            )}
            {tab === "target" && (
              <Line label={t("calc.targetPrice")} hint={t("calc.targetHint")}>
                <dd>{price(target)}</dd>
              </Line>
            )}
            {tab === "liq" && (
              <Line label={t("calc.liqPrice")} hint={t("calc.liqHint")}>
                <dd>{price(liq)}</dd>
              </Line>
            )}
            {tab === "maxOpen" && (
              <>
                <Line label={t("calc.maxSize")}>
                  <dd>{most ? `${formatNumber(most.size, sizeDecimals)} ${base}` : "-"}</dd>
                </Line>
                <Line label={t("calc.value")}>
                  <dd>{money(most?.value)}</dd>
                </Line>
              </>
            )}
          </dl>

          {tooMuch && (
            <p className="pd-calc-warning" role="status">
              {t("calc.overMax", { max: maxLeverage })}
            </p>
          )}

          {tab === "maxOpen" && (
            <button
              type="button"
              className="pd-calc-use"
              disabled={!most || most.size <= 0}
              onClick={() => most && onUse(most.text)}
            >
              {t("calc.use")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
