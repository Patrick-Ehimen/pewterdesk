import { ChartCurrency, t } from "@pewterdesk/ui";
import { useState } from "react";
import { applyAppCurrency, loadAppCurrency, saveAppCurrency } from "../../lib/appCurrency";
import { FX_CURRENCIES } from "../../lib/fxRates";
import { GroupLabel } from "./parts";

/** The currency the app shows money in. Orders stay in the venue's own. */
export function CurrencySetting() {
  const [code, setCode] = useState(loadAppCurrency);
  const [failed, setFailed] = useState(false);
  const change = async (next: string | undefined) => {
    setCode(next);
    saveAppCurrency(next);
    setFailed(!(await applyAppCurrency(next)));
  };
  return (
    <>
      <GroupLabel>{t("settings.currency")}</GroupLabel>
      <p className="settings-help">{t("settings.currencyHelp")}</p>
      <ChartCurrency
        field
        label={t("settings.currency")}
        quote={t("settings.currencyOwn")}
        currencies={FX_CURRENCIES}
        value={code}
        onChange={(next) => void change(next)}
      />
      {failed && <p className="settings-help">{t("settings.currencyFailed")}</p>}
    </>
  );
}
