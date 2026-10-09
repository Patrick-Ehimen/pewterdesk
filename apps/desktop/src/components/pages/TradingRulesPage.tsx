import { useEffect, useState } from "react";
import { loadRules, type RulesStatus, saveRules } from "../../lib/tradingRules";
import { RulesDashboard } from "../rules/RulesDashboard";
import { RulesEditor } from "../rules/RulesEditor";

interface TradingRulesPageProps {
  /** The venue on screen: its account is the one the rules are checked against. */
  venue: string;
  /** The connected account's equity, in USD. */
  equity?: number;
  /** Where the account stands against the rules; unset until that's tracked. */
  status?: RulesStatus;
}

/**
 * Trading rules (after the Rules mockups in `design/`): a dashboard of the
 * trader's limits, a challenge to hold the account to and the tilt signals,
 * and an editor for them. The rules are kept; nothing tracks or enforces
 * them yet, and the page says so.
 */
export function TradingRulesPage({ venue, equity, status }: TradingRulesPageProps) {
  const [rules, setRules] = useState(loadRules);
  const [editing, setEditing] = useState(false);
  // The trading hours count down by the minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return editing ? (
    <RulesEditor
      rules={rules}
      venue={venue}
      onCancel={() => setEditing(false)}
      onSave={(next) => {
        setRules(next);
        saveRules(next);
        setEditing(false);
      }}
    />
  ) : (
    <RulesDashboard
      rules={rules}
      venue={venue}
      equity={equity}
      status={status}
      now={now}
      onEdit={() => setEditing(true)}
    />
  );
}
