import { useEffect, useMemo, useRef, useState } from "react";
import { LuChevronDown, LuChevronUp, LuSearch } from "react-icons/lu";
import { currentLocale, t } from "../../i18n";

/** A currency's flag, from the country its code begins with ("NG" for NGN). */
const flagOf = (code: string) =>
  String.fromCodePoint(...[...code.slice(0, 2)].map((c) => 0x1f1a5 + c.charCodeAt(0)));

/**
 * A currency to show money in: the chart's, on its price axis as TradingView
 * has it, or with `field` a form field of its own. The venue's own or any on
 * offer, with a search. It only changes what's shown.
 */
export function ChartCurrency({
  quote,
  currencies,
  value,
  onChange,
  field,
  label,
  ownName,
}: {
  /** The market's own quote asset, e.g. "USDT"; in a field, what its first row is called. */
  quote: string;
  currencies: readonly string[];
  /** Undefined for the market's own. */
  value?: string;
  onChange: (currency: string | undefined) => void;
  /** Sits in a form, with the currency's name on the button. */
  field?: boolean;
  /** What it's for, to a screen reader. */
  label?: string;
  /** Beside the first row's code. */
  ownName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Intl.DisplayNames([currentLocale()], { type: "currency" }), []);
  const nameOf = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const text = query.trim().toLowerCase();
  const found = currencies.filter(
    (c) => !text || c.toLowerCase().includes(text) || nameOf(c).toLowerCase().includes(text),
  );
  const pick = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={box} className="pd-chart-currency" data-field={field || undefined}>
      <button
        type="button"
        className="pd-chart-currency-button"
        aria-expanded={open}
        aria-label={label ?? t("chart.currency")}
        title={field ? undefined : t("chart.currency")}
        onClick={() => setOpen(!open)}
      >
        {field && value ? (
          <span className="pd-chart-currency-picked">
            <span aria-hidden>{flagOf(value)}</span>
            <strong>{value}</strong>
            <span className="pd-chart-currency-name">{nameOf(value)}</span>
          </span>
        ) : (
          <span className="pd-chart-currency-picked">{value ?? quote}</span>
        )}
        {open ? <LuChevronUp size={13} aria-hidden /> : <LuChevronDown size={13} aria-hidden />}
      </button>
      {open && (
        <div className="pd-chart-currency-menu">
          <p className="pd-chart-currency-head">{t("chart.currencies")}</p>
          <label className="pd-chart-currency-search">
            <LuSearch size={15} aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
              autoFocus
              type="text"
              value={query}
              placeholder={t("chart.currencySearch")}
              aria-label={t("chart.currencySearch")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            />
          </label>
          <ul className="pd-chart-currency-list">
            {!text && (
              <li>
                <button
                  type="button"
                  className="pd-chart-currency-row"
                  aria-current={value === undefined}
                  onClick={() => pick(undefined)}
                >
                  <span className="pd-chart-currency-flag" aria-hidden>
                    $
                  </span>
                  {field ? (
                    <span className="pd-chart-currency-whole">{quote}</span>
                  ) : (
                    <>
                      <span className="pd-chart-currency-code">{quote}</span>
                      <span className="pd-chart-currency-name">
                        {ownName ?? t("chart.currencyOwn")}
                      </span>
                    </>
                  )}
                </button>
              </li>
            )}
            {found.map((code) => (
              <li key={code}>
                <button
                  type="button"
                  className="pd-chart-currency-row"
                  aria-current={value === code}
                  onClick={() => pick(code)}
                >
                  <span className="pd-chart-currency-flag" aria-hidden>
                    {flagOf(code)}
                  </span>
                  <span className="pd-chart-currency-code">{code}</span>
                  <span className="pd-chart-currency-name">{nameOf(code)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
