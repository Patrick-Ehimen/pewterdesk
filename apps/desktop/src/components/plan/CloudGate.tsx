import { t } from "@pewterdesk/ui";
import { useState } from "react";
import { LuCheck, LuCloud, LuMail } from "react-icons/lu";
import type { useCloudAuth } from "../../hooks/useJournal";

/**
 * Signing in to PewterDesk Cloud: an email, then the code sent to it. Nothing
 * of the journal shows until then; trading never needs it.
 */
export function CloudGate({ cloud }: { cloud: ReturnType<typeof useCloudAuth> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const { auth } = cloud;
  if (auth.state === "loading") return <p className="jr-empty">{t("plan.loading")}</p>;
  if (auth.state === "notConfigured")
    return (
      <div className="jr-gate">
        <span className="jr-gate-icon">
          <LuCloud size={22} aria-hidden />
        </span>
        <h2>{t("cloud.title")}</h2>
        <p>{t("cloud.notConfigured")}</p>
      </div>
    );

  return (
    <div className="jr-gate">
      <span className="jr-gate-icon">
        <LuCloud size={22} aria-hidden />
      </span>
      <h2>{t("cloud.title")}</h2>
      <p>{t("cloud.why")}</p>
      <ul className="jr-gate-points">
        {(["cloud.point.keys", "cloud.point.own", "cloud.point.optional"] as const).map((k) => (
          <li key={k}>
            <LuCheck size={13} aria-hidden />
            <span>{t(k)}</span>
          </li>
        ))}
      </ul>
      {auth.state === "unavailable" && <p className="jr-error">{auth.error}</p>}
      <form
        className="jr-gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sent)
            void run(async () => {
              await cloud.sendCode(email);
              setSent(true);
            });
          else void run(() => cloud.verify(email, code));
        }}
      >
        <label className="jr-field-label" htmlFor="jr-email">
          {t("cloud.email")}
        </label>
        <span className="jr-input-icon">
          <LuMail size={14} aria-hidden />
          <input
            id="jr-email"
            className="pd-input"
            type="email"
            autoComplete="email"
            value={email}
            disabled={sent}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </span>
        {sent && (
          <>
            <label className="jr-field-label" htmlFor="jr-code">
              {t("cloud.code")}
            </label>
            <input
              id="jr-code"
              className="pd-input pd-num jr-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))}
              required
            />
            <p className="jr-hint">{t("cloud.sent", { email })}</p>
          </>
        )}
        {error && <p className="jr-error">{error}</p>}
        <div className="jr-actions">
          {sent && (
            <button
              type="button"
              className="jr-button"
              disabled={busy}
              onClick={() => {
                setSent(false);
                setCode("");
              }}
            >
              {t("cloud.otherEmail")}
            </button>
          )}
          <button
            type="submit"
            className="jr-button jr-primary"
            disabled={busy || !email || (sent && code.length < 6)}
          >
            {sent ? t("cloud.signIn") : t("cloud.sendCode")}
          </button>
        </div>
      </form>
    </div>
  );
}
