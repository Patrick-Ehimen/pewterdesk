//! The router: one method per trading operation, each doing
//! `trading_account` → gate → adapter. The only caller of an adapter's
//! trading methods.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md`:
//! - The router builds the account's key reference itself
//!   (`trading_account`): the caller names an account, never a key.
//! - A Bybit demo account (demo funds, on Bybit's demo host) trades as soon
//!   as it's connected. Every other account is live - a Bybit live account,
//!   and any Hyperliquid or Aster account - and trades only once live
//!   trading has been turned on for it (`live`).
//! - The trader's rules (`rules`) are checked before an order is placed, an
//!   order is amended, or a position's protection is changed. A cancel, and
//!   leverage and margin mode (which open nothing), pass the switch only.

use std::path::Path;

use pewterdesk_core::accounts::{
    bybit_account, bybit_key_entry, normalize_address, wallet_key_entry,
};
use pewterdesk_core::{
    Decimal, MarginMode, Order, OrderAmend, OrderRequest, PositionProtection, TradingAccount,
    VenueError, VenueId,
};

use crate::live::{self, LiveTrading};
use crate::rules::{self, TradingRules};
use crate::{Adapters, Calendar};

/// Who trades for `account` on `venue`, if it may trade at all.
pub fn trading_account(
    venue: VenueId,
    account: &str,
    live: &LiveTrading,
) -> Result<TradingAccount, VenueError> {
    match venue {
        VenueId::Bybit => {
            let (demo, uid) = bybit_account(account)?;
            if !demo && !live.is_on(uid) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on under Accounts".into(),
                ));
            }
            Ok(TradingAccount {
                address: account.to_owned(),
                key: bybit_key_entry(account)?,
            })
        }
        // Always real funds, so always behind the switch.
        VenueId::Hyperliquid | VenueId::Aster => {
            let address = normalize_address(account)?;
            if !live.is_on(&live::wallet_id(venue, &address)?) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on in the wallet's details"
                        .into(),
                ));
            }
            Ok(TradingAccount {
                key: wallet_key_entry(venue, &address),
                address,
            })
        }
    }
}

/// The router and the gate it checks: the live-trading switch and the
/// trader's rules.
pub struct Engine {
    live: LiveTrading,
    rules: TradingRules,
}

impl Engine {
    /// The gate as kept in `config_dir` (`live-trading.json` and
    /// `trading-rules.json`). Without a folder nothing can be kept: no live
    /// account trades, and no rules are set.
    pub fn load(config_dir: Option<&Path>) -> Self {
        Self {
            live: LiveTrading::load(config_dir.map(|dir| dir.join(live::FILE))),
            rules: TradingRules::load(config_dir.map(|dir| dir.join(rules::FILE))),
        }
    }

    /// The live-trading switch, for the host's commands that show and set it.
    pub fn live(&self) -> &LiveTrading {
        &self.live
    }

    /// The trader's rules, for the host's commands that show and set them.
    pub fn rules(&self) -> &TradingRules {
        &self.rules
    }

    /// Places an order for `account`.
    pub async fn place_order(
        &self,
        venues: &dyn Adapters,
        calendar: &dyn Calendar,
        venue: VenueId,
        account: &str,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        // The trader's own rules, before anything is signed.
        self.rules
            .guard_order(venues, calendar, venue, account, request)
            .await?;
        venues.adapter(venue)?.place_order(&trading, request).await
    }

    /// Cancels `account`'s open order `order_id`.
    pub async fn cancel_order(
        &self,
        venues: &dyn Adapters,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        venues
            .adapter(venue)?
            .cancel_order(&trading, market, order_id)
            .await
    }

    /// Changes `account`'s open order `order_id`: price, size, or attached TP/SL.
    pub async fn amend_order(
        &self,
        venues: &dyn Adapters,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        self.rules
            .guard_amend(venues, venue, account, order_id, amend)
            .await?;
        venues
            .adapter(venue)?
            .amend_order(&trading, market, order_id, amend)
            .await
    }

    /// Sets the take-profit, stop-loss and trailing stop on `account`'s
    /// position in `market`, all at once (`None` removes one). Protective only.
    pub async fn set_position_protection(
        &self,
        venues: &dyn Adapters,
        venue: VenueId,
        account: &str,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        self.rules
            .guard_protection(venues, venue, account, market, protection)
            .await?;
        venues
            .adapter(venue)?
            .set_position_protection(&trading, market, protection)
            .await
    }

    /// Sets `account`'s leverage on `market`.
    pub async fn set_leverage(
        &self,
        venues: &dyn Adapters,
        venue: VenueId,
        account: &str,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        venues
            .adapter(venue)?
            .set_leverage(&trading, market, leverage)
            .await
    }

    /// Switches `account` between cross and isolated margin (account-wide on Bybit).
    pub async fn set_margin_mode(
        &self,
        venues: &dyn Adapters,
        venue: VenueId,
        account: &str,
        market: &str,
        mode: MarginMode,
    ) -> Result<(), VenueError> {
        let trading = trading_account(venue, account, &self.live)?;
        venues
            .adapter(venue)?
            .set_margin_mode(&trading, market, mode)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_account_trades_only_once_its_turned_on() {
        let path = std::env::temp_dir()
            .join(format!("pewterdesk-gate-{}", std::process::id()))
            .join(live::FILE);
        let live = LiveTrading::load(Some(path.clone()));
        // Demo accounts need no switch.
        let demo = trading_account(VenueId::Bybit, "demo:24617703", &live).unwrap();
        assert_eq!(demo.address, "demo:24617703");
        assert_eq!(demo.key, "bybit:demo:24617703");
        assert!(trading_account(VenueId::Bybit, "demo:x", &live).is_err());
        // A live one is refused until it's on, and only that account is let through.
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617703", &live),
            Err(VenueError::Rejected(_))
        ));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"["24617703"]"#).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        let account = trading_account(VenueId::Bybit, "24617703", &on).unwrap();
        assert_eq!(account.address, "24617703");
        assert_eq!(account.key, "bybit:24617703");
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617704", &on),
            Err(VenueError::Rejected(_))
        ));
        // A wallet on Hyperliquid or Aster is always live: refused until
        // it's on, and then only that venue's account, under its own key.
        let wallet = format!("0x{}", "a".repeat(40));
        let other = format!("0x{}", "b".repeat(40));
        for venue in [VenueId::Hyperliquid, VenueId::Aster] {
            assert!(matches!(
                trading_account(venue, &wallet, &on),
                Err(VenueError::Rejected(_))
            ));
        }
        std::fs::write(&path, format!(r#"["hyperliquid:{wallet}"]"#)).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        // However the page spells the address, the key is the stored one's.
        let spelled = format!(" 0x{} ", "A".repeat(40));
        let account = trading_account(VenueId::Hyperliquid, &spelled, &on).unwrap();
        assert_eq!(account.address, wallet);
        assert_eq!(account.key, format!("hyperliquid:{wallet}"));
        assert!(matches!(
            trading_account(VenueId::Aster, &wallet, &on),
            Err(VenueError::Rejected(_))
        ));
        assert!(matches!(
            trading_account(VenueId::Hyperliquid, &other, &on),
            Err(VenueError::Rejected(_))
        ));
        assert!(matches!(
            trading_account(VenueId::Hyperliquid, "24617703", &on),
            Err(VenueError::InvalidRequest(_))
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
