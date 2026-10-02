import { logo, upcomingVenueLogos, venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { type MessageKey, shortAddress, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { LuArrowRight, LuCheck, LuCircleCheck, LuCircleX, LuLoader, LuX } from "react-icons/lu";
import { appClient } from "../../api/appClient";
import { isLightTheme, THEMES, type Theme } from "../../hooks/useAppearance";
import { useVenueProbe } from "../../hooks/useVenueProbe";
import { connectedBybit, connectedWallet, subscribeAccounts } from "../../lib/account";
import type { OnboardingState } from "../../lib/onboarding";
import { VENUE_IDS, VENUES } from "../../lib/venues";
import { tauriSecretStore } from "../../secrets/tauriSecretStore";
import { ThemeSwatch } from "../header/ThemeSwatch";
import { ApiKeyBody } from "../wallet/ApiKeyDialog";
import { ConnectWalletBody, type MethodId } from "../wallet/ConnectWalletDialog";

type StepId = "welcome" | "keys" | "venues" | "connect" | "workspace" | "ready";
const STEPS: readonly StepId[] = ["welcome", "keys", "venues", "connect", "workspace", "ready"];

const STEP_TITLE: Record<StepId, MessageKey> = {
  welcome: "onb.step.welcome",
  keys: "onb.step.keys",
  venues: "onb.step.venues",
  connect: "onb.step.connect",
  workspace: "onb.step.workspace",
  ready: "onb.step.ready",
};

/** What each launch venue runs on, under its name. */
const VENUE_CHAIN: Record<VenueId, MessageKey> = {
  bybit: "onb.chain.bybit",
  hyperliquid: "onb.chain.hyperliquid",
  aster: "onb.chain.aster",
};

/** Venues to come: shown so the roadmap is visible, not selectable. */
const UPCOMING: readonly {
  id: keyof typeof upcomingVenueLogos;
  name: string;
  chain: MessageKey;
}[] = [
  { id: "gmx", name: "GMX", chain: "onb.chain.gmx" },
  { id: "dydx", name: "dYdX", chain: "onb.chain.dydx" },
];

type CheckStatus = "pending" | "ok" | "fail";
interface Check {
  label: MessageKey;
  status: CheckStatus;
  detail?: string;
}

/** The welcome step's checks: the keychain answers, venues respond, the build. */
function useSystemChecks(): Check[] {
  const [keychain, setKeychain] = useState<Check>({
    label: "onb.check.keychain",
    status: "pending",
  });
  const [build, setBuild] = useState<Check>({ label: "onb.check.build", status: "pending" });

  useEffect(() => {
    let live = true;
    // A read of an entry that doesn't exist: proves the keychain answers,
    // without storing or reading anything real.
    tauriSecretStore.has("pd.setup-check").then(
      () => live && setKeychain((c) => ({ ...c, status: "ok", detail: t("onb.check.keychainOk") })),
      (e: unknown) =>
        live &&
        setKeychain((c) => ({
          ...c,
          status: "fail",
          detail: e instanceof Error ? e.message : t("error.failed"),
        })),
    );
    appClient.info().then(
      (info) =>
        live &&
        setBuild((c) =>
          info
            ? {
                ...c,
                status: "ok",
                detail: `v${info.version} · ${info.os} ${info.arch} · ${t(
                  info.debug ? "onb.check.dev" : "onb.check.release",
                )}`,
              }
            : { ...c, status: "fail", detail: t("onb.check.noApp") },
        ),
      () => live && setBuild((c) => ({ ...c, status: "fail", detail: t("error.failed") })),
    );
    return () => {
      live = false;
    };
  }, []);

  const probes = useVenueProbe();
  const results = Object.values(probes);
  const reached = results.flatMap((p) => (p.status === "up" ? [p.ms] : []));
  const venues: Check = {
    label: "onb.check.venues",
    status: results.some((p) => p.status === "checking")
      ? "pending"
      : reached.length === results.length
        ? "ok"
        : "fail",
    detail: t("onb.check.venuesDetail", {
      reached: reached.length,
      total: results.length,
      fastest: reached.length > 0 ? Math.min(...reached) : "-",
    }),
  };
  return [keychain, venues, build];
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "ok") return <LuCheck className="onb-ok" size={15} aria-hidden />;
  if (status === "fail") return <LuX className="onb-fail" size={15} aria-hidden />;
  return <LuLoader className="onb-spin" size={15} aria-hidden />;
}

function Welcome() {
  const checks = useSystemChecks();
  const passed = checks.filter((c) => c.status === "ok").length;
  return (
    <>
      <div className="onb-cards">
        {(["custody", "direct", "speed"] as const).map((id) => (
          <div key={id} className="onb-card">
            <strong>{t(`onb.welcome.${id}`)}</strong>
            <p>{t(`onb.welcome.${id}Body`)}</p>
          </div>
        ))}
      </div>
      <section className="onb-table" aria-labelledby="onb-checks">
        <header>
          <h3 id="onb-checks">{t("onb.check.title")}</h3>
          <span className="onb-ok">{t("onb.check.passed", { passed, total: checks.length })}</span>
        </header>
        <ul>
          {checks.map((c) => (
            <li key={c.label}>
              <StatusIcon status={c.status} />
              <span>{t(c.label)}</span>
              <span className="onb-detail pd-num">{c.detail ?? ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Keys() {
  const flow = ["wallet", "key", "signed", "venues"] as const;
  return (
    <>
      <ol className="onb-flow">
        {flow.map((id, i) => (
          <li key={id} data-accent={id === "key" || undefined}>
            <strong>{t(`onb.keys.${id}`)}</strong>
            <span>{t(`onb.keys.${id}Body`)}</span>
            {i < flow.length - 1 && (
              <LuArrowRight className="onb-flow-arrow" size={16} aria-hidden />
            )}
          </li>
        ))}
      </ol>
      <div className="onb-split">
        <section className="onb-list">
          <h3>{t("onb.keys.can")}</h3>
          <ul>
            {(["can1", "can2", "can3"] as const).map((k) => (
              <li key={k}>
                <LuCircleCheck className="onb-ok" size={16} aria-hidden />
                {t(`onb.keys.${k}`)}
              </li>
            ))}
          </ul>
        </section>
        <section className="onb-list">
          <h3>{t("onb.keys.cant")}</h3>
          <ul>
            {(["cant1", "cant2", "cant3"] as const).map((k) => (
              <li key={k}>
                <LuCircleX className="onb-no" size={16} aria-hidden />
                {t(`onb.keys.${k}`)}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Venues({
  state,
  onChange,
}: {
  state: OnboardingState;
  onChange: (next: OnboardingState) => void;
}) {
  const toggle = (id: VenueId) => {
    const has = state.venues.includes(id);
    // At least one venue stays on.
    if (has && state.venues.length === 1) return;
    const venues = has ? state.venues.filter((v) => v !== id) : [...state.venues, id];
    onChange({ ...state, venues: VENUE_IDS.filter((v) => venues.includes(v)) });
  };
  return (
    <>
      <fieldset className="onb-venues">
        <legend className="pd-visually-hidden">{t("onb.step.venues")}</legend>
        {VENUE_IDS.map((id) => {
          const on = state.venues.includes(id);
          return (
            // biome-ignore lint/a11y/useSemanticElements: a card-style checkbox, like the wallet methods
            <button
              key={id}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="onb-venue"
              onClick={() => toggle(id)}
            >
              <img src={venueLogos[id]} alt="" />
              <span className="onb-venue-text">
                <strong>{VENUES[id].label}</strong>
                <span>{t(VENUE_CHAIN[id])}</span>
              </span>
              <span className="onb-box" aria-hidden>
                {on && <LuCheck size={13} />}
              </span>
            </button>
          );
        })}
        {UPCOMING.map((v) => (
          <div key={v.id} className="onb-venue" data-soon aria-disabled="true">
            <img src={upcomingVenueLogos[v.id]} alt="" />
            <span className="onb-venue-text">
              <strong>{v.name}</strong>
              <span>{t(v.chain)}</span>
            </span>
            <span className="onb-soon">{t("wallet.soon")}</span>
          </div>
        ))}
      </fieldset>

      <div className="onb-networks" role="radiogroup" aria-label={t("onb.network")}>
        {/* biome-ignore lint/a11y/useSemanticElements: a card-style radio */}
        <button
          type="button"
          role="radio"
          aria-checked={state.network === "mainnet"}
          className="onb-network"
          onClick={() => onChange({ ...state, network: "mainnet" })}
        >
          <span className="onb-radio" aria-hidden />
          <strong>{t("onb.mainnet")}</strong>
          <span>{t("onb.mainnetBody")}</span>
        </button>
        <div className="onb-network" data-soon aria-disabled="true">
          <span className="onb-radio" aria-hidden />
          <strong>
            {t("onb.testnet")} <span className="onb-soon">{t("wallet.soon")}</span>
          </strong>
          <span>{t("onb.testnetBody")}</span>
        </div>
      </div>
    </>
  );
}

function Connect({ venues }: { venues: readonly VenueId[] }) {
  const [method, setMethod] = useState<MethodId>("browser");
  return (
    <>
      {venues.includes("aster") && <p className="onb-note">{t("onb.connect.asterNote")}</p>}
      {/* Only Hyperliquid connects with a wallet today; Bybit takes an API key. */}
      {venues.includes("hyperliquid") && (
        <div className="onb-connect">
          <ConnectWalletBody selected={method} onSelect={setMethod} />
        </div>
      )}
      {venues.includes("bybit") && (
        <div className="onb-connect onb-connect-key">
          <ApiKeyBody venue="bybit" />
        </div>
      )}
    </>
  );
}

function Workspace({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <div className="onb-themes" role="radiogroup" aria-label={t("onb.theme")}>
      {THEMES.map((id) => (
        // biome-ignore lint/a11y/useSemanticElements: a card-style radio
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={id === theme}
          className="onb-theme"
          onClick={() => onTheme(id)}
        >
          <ThemeSwatch theme={id} />
          <strong>{t(`theme.${id}.name`)}</strong>
          <span>{t(`theme.${id}.desc`)}</span>
        </button>
      ))}
    </div>
  );
}

function Ready({
  state,
  theme,
  onEdit,
}: {
  state: OnboardingState;
  theme: Theme;
  onEdit: (step: StepId) => void;
}) {
  const wallet = useSyncExternalStore(subscribeAccounts, connectedWallet);
  const bybitUid = useSyncExternalStore(subscribeAccounts, connectedBybit);
  const keys = (wallet ? 1 : 0) + (bybitUid ? 1 : 0);
  const rows: [MessageKey, string, StepId][] = [
    ["onb.ready.network", t("onb.mainnet"), "venues"],
    ["onb.ready.venues", state.venues.map((v) => VENUES[v].label).join(", "), "venues"],
    [
      "onb.ready.wallet",
      wallet
        ? `${VENUES[wallet.venue].label} · ${shortAddress(wallet.address)}`
        : t("onb.ready.noWallet"),
      "connect",
    ],
    ...(bybitUid
      ? [
          ["onb.ready.bybit", t("onb.ready.bybitUid", { uid: bybitUid }), "connect"] satisfies [
            MessageKey,
            string,
            StepId,
          ],
        ]
      : []),
    [
      "onb.ready.trading",
      keys === 0
        ? t("onb.ready.noKeys")
        : keys === 1
          ? t("onb.ready.oneKey")
          : t("onb.ready.keys", { count: keys }),
      "connect",
    ],
    ["onb.ready.theme", t(`theme.${theme}.name`), "workspace"],
  ];
  return (
    <dl className="onb-table onb-summary">
      {rows.map(([label, value, step]) => (
        <div key={label}>
          <dt>{t(label)}</dt>
          <dd>{value}</dd>
          <dd>
            <button type="button" className="onb-edit" onClick={() => onEdit(step)}>
              {t("onb.edit")}
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * First-run setup, after the design (design/screens/24-*): a sidebar of steps
 * with progress, and each step on the right. Only what works today is here:
 * system check, how keys work, venues (GMX and dYdX shown as coming soon) and
 * network (testnet coming soon), connecting a wallet, theme, and a summary.
 */
export function Onboarding({
  initial,
  theme,
  onTheme,
  onDone,
}: {
  initial: OnboardingState;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onDone: (state: OnboardingState) => void;
}) {
  const [state, setState] = useState(initial);
  const [step, setStep] = useState<StepId>("welcome");
  const wallet = useSyncExternalStore(subscribeAccounts, connectedWallet);
  const index = STEPS.indexOf(step);
  const progress = Math.round((index / (STEPS.length - 1)) * 100);

  const subtitle: Record<StepId, string> = {
    welcome: t("onb.sub.welcome"),
    keys: t("onb.sub.keys"),
    venues: t("onb.sub.venues", { count: state.venues.length, network: t("onb.mainnet") }),
    connect: wallet ? shortAddress(wallet.address) : t("onb.sub.connect"),
    workspace: t(`theme.${theme}.name`),
    ready: t("onb.sub.ready"),
  };
  const done = (id: StepId) => STEPS.indexOf(id) < index;
  const go = (offset: number) => {
    const next = STEPS[index + offset];
    if (next) setStep(next);
  };

  const content: Record<StepId, ReactNode> = {
    welcome: <Welcome />,
    keys: <Keys />,
    venues: <Venues state={state} onChange={setState} />,
    connect: <Connect venues={state.venues} />,
    workspace: <Workspace theme={theme} onTheme={onTheme} />,
    ready: <Ready state={state} theme={theme} onEdit={setStep} />,
  };

  return (
    <div className="onb">
      <aside className="onb-side">
        <img
          className="onb-logo"
          src={isLightTheme(theme) ? logo.horizontal.lightBg : logo.horizontal.darkBg}
          alt="pewterdesk"
        />
        <div className="onb-progress">
          <span>{t("onb.setup")}</span>
          <span className="pd-num">{progress}%</span>
          <div className="onb-bar">
            <div style={{ width: `${progress}%` }} />
          </div>
        </div>
        <ol className="onb-steps">
          {STEPS.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                className="onb-step"
                aria-current={id === step ? "step" : undefined}
                data-done={done(id) || undefined}
                onClick={() => setStep(id)}
              >
                <span className="onb-step-num" aria-hidden>
                  {done(id) ? <LuCheck size={13} /> : i + 1}
                </span>
                <span className="onb-step-text">
                  <strong>{t(STEP_TITLE[id])}</strong>
                  <span>{subtitle[id]}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className="onb-aside-note">{t("onb.asideNote")}</p>
      </aside>

      <main className="onb-main">
        <div className="onb-content">
          {/* Without Hyperliquid there's no wallet to connect, only Bybit's API key. */}
          {step === "connect" && !state.venues.includes("hyperliquid") ? (
            <>
              <h1>{t("onb.connect.keyTitle")}</h1>
              <p className="onb-lead">{t("onb.connect.keyLead")}</p>
            </>
          ) : (
            <>
              <h1>{t(`onb.${step}.title`)}</h1>
              <p className="onb-lead">{t(`onb.${step}.lead`)}</p>
            </>
          )}
          {content[step]}
        </div>
        <footer className="onb-foot">
          <span className="onb-count">
            {t("onb.stepOf", { step: index + 1, total: STEPS.length })}
          </span>
          {step === "connect" && !wallet && (
            <button type="button" className="onb-skip" onClick={() => go(1)}>
              {t("onb.skip")}
            </button>
          )}
          {index > 0 && (
            <button type="button" className="onb-back" onClick={() => go(-1)}>
              {t("onb.back")}
            </button>
          )}
          {step === "ready" ? (
            <button
              type="button"
              className="onb-next"
              onClick={() => onDone({ ...state, done: true })}
            >
              {t("onb.open")}
            </button>
          ) : (
            <button type="button" className="onb-next" onClick={() => go(1)}>
              {t("onb.continue")}
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}
