//! Market data and account state for algos, shared: one venue subscription
//! per market (and per account), fanned out to every executor that needs
//! it, and closed when the last one lets go. A feed that ends is
//! resubscribed with a backoff; meanwhile it reads as disconnected, and the
//! executors on it pause.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use pewterdesk_core::{AccountSnapshot, OrderBook, VenueError, VenueId};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::Host;

/// Longest wait between resubscribes.
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// The latest value of a feed, and whether it's live.
#[derive(Debug)]
pub struct Sample<T> {
    pub value: Option<Arc<T>>,
    /// When `value` arrived.
    pub at: Option<Instant>,
    /// The venue subscription is up.
    pub connected: bool,
    /// Bumped on every (re)connection, so a reader can tell it reconnected.
    pub generation: u64,
}

impl<T> Clone for Sample<T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
            at: self.at,
            connected: self.connected,
            generation: self.generation,
        }
    }
}

impl<T> Default for Sample<T> {
    fn default() -> Self {
        Self {
            value: None,
            at: None,
            connected: false,
            generation: 0,
        }
    }
}

impl<T> Sample<T> {
    /// The value, if it's live and no older than `within`.
    pub fn fresh(&self, within: Duration) -> Option<&Arc<T>> {
        let recent = self.at.is_some_and(|at| at.elapsed() <= within);
        (self.connected && recent).then_some(self.value.as_ref()?)
    }
}

/// One shared subscription. Dropping the last handle ends it.
pub struct Feed<T> {
    rx: watch::Receiver<Sample<T>>,
    task: JoinHandle<()>,
}

impl<T> Feed<T> {
    pub fn latest(&self) -> Sample<T> {
        self.rx.borrow().clone()
    }

    /// A receiver that wakes on every new sample.
    pub fn watch(&self) -> watch::Receiver<Sample<T>> {
        self.rx.clone()
    }
}

impl<T> Drop for Feed<T> {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Subscribe<T> = Box<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<mpsc::Receiver<T>, VenueError>> + Send>>
        + Send
        + Sync,
>;

/// Pumps a venue subscription into `tx`, resubscribing when it ends.
fn pump<T: Send + Sync + 'static>(
    subscribe: Subscribe<T>,
    tx: watch::Sender<Sample<T>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        let mut generation = 0;
        loop {
            if let Ok(mut rx) = subscribe().await {
                generation += 1;
                tx.send_modify(|s| {
                    s.connected = true;
                    s.generation = generation;
                });
                while let Some(value) = rx.recv().await {
                    backoff = Duration::from_secs(1);
                    tx.send_modify(|s| {
                        s.value = Some(Arc::new(value));
                        s.at = Some(Instant::now());
                    });
                }
            }
            tx.send_modify(|s| s.connected = false);
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    })
}

/// The feeds of one kind, by venue and market (or account).
type Shared<T> = Mutex<HashMap<(VenueId, String), Weak<Feed<T>>>>;

/// Every shared feed, by venue and market (or account).
#[derive(Default)]
pub struct Feeds {
    books: Shared<OrderBook>,
    accounts: Shared<AccountSnapshot>,
}

impl Feeds {
    /// `market`'s order book on `venue`, shared.
    pub fn book(&self, host: &Arc<dyn Host>, venue: VenueId, market: &str) -> Arc<Feed<OrderBook>> {
        let key = (venue, market.to_owned());
        let mut books = self.books.lock().unwrap();
        if let Some(feed) = books.get(&key).and_then(Weak::upgrade) {
            return feed;
        }
        let (tx, rx) = watch::channel(Sample::default());
        let host = Arc::clone(host);
        let market = market.to_owned();
        let subscribe: Subscribe<OrderBook> = Box::new(move || {
            let host = Arc::clone(&host);
            let market = market.clone();
            Box::pin(async move {
                host.venues()
                    .adapter(venue)?
                    .subscribe_order_book(&market)
                    .await
            })
        });
        let feed = Arc::new(Feed {
            rx,
            task: pump(subscribe, tx),
        });
        books.retain(|_, weak| weak.strong_count() > 0);
        books.insert(key, Arc::downgrade(&feed));
        feed
    }

    /// `account`'s state on `venue` (balances, positions, open orders), shared.
    pub fn account(
        &self,
        host: &Arc<dyn Host>,
        venue: VenueId,
        account: &str,
    ) -> Arc<Feed<AccountSnapshot>> {
        let key = (venue, account.to_owned());
        let mut accounts = self.accounts.lock().unwrap();
        if let Some(feed) = accounts.get(&key).and_then(Weak::upgrade) {
            return feed;
        }
        let (tx, rx) = watch::channel(Sample::default());
        let host = Arc::clone(host);
        let account = account.to_owned();
        let subscribe: Subscribe<AccountSnapshot> = Box::new(move || {
            let host = Arc::clone(&host);
            let account = account.clone();
            Box::pin(async move {
                host.venues()
                    .adapter(venue)?
                    .subscribe_account(&account)
                    .await
            })
        });
        let feed = Arc::new(Feed {
            rx,
            task: pump(subscribe, tx),
        });
        accounts.retain(|_, weak| weak.strong_count() > 0);
        accounts.insert(key, Arc::downgrade(&feed));
        feed
    }
}
