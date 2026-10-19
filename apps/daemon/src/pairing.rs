//! Who may talk to the daemon. A client asks to be paired; the user
//! approves it once, on this machine (a prompt in the terminal `pdd` runs
//! in, or a system dialog when it runs in the background); the client gets
//! a token, once, to keep in its own keychain and send in every `hello`.
//! The daemon keeps only a hash of each token, beside the client's name, in
//! a file only this user can read; `pd clients revoke` takes one away.
//!
//! Security-relevant (docs/bots/safety.md, rule 6): until a client is
//! paired, it can only say hello and ask to be. Approval never comes over
//! the protocol: only the person at this machine gives it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pewterdesk_protocol::rpc::{
    code, ClientInfo, ClientKind, PairState, PairTicket, PairedClient, RpcError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How long a request waits on the user.
const WAIT_FOR: Duration = Duration::from_secs(180);
/// Requests waiting at once: more are turned away, so nothing can pile
/// prompts up in front of the user.
const MAX_WAITING: usize = 3;
const MAX_NAME: usize = 60;
const MAX_CLIENTS: usize = 32;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// `n` random bytes, as hex.
fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::getrandom(&mut bytes).expect("the OS gives random bytes");
    hex::encode(bytes)
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Equal without leaking where they differ through timing.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// A client's name as it says it, made fit to show a person: printable,
/// on one line, not long.
pub fn tidy_name(name: &str) -> String {
    let tidy: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME)
        .collect();
    let tidy = tidy.trim();
    if tidy.is_empty() {
        "an unnamed client".into()
    } else {
        tidy.to_owned()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    name: String,
    kind: ClientKind,
    paired_at: u64,
    /// SHA-256 of its token. The token itself is only ever in the client's keychain.
    token_hash: String,
}

impl Stored {
    fn public(&self) -> PairedClient {
        PairedClient {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            paired_at: self.paired_at,
        }
    }
}

/// The paired clients, kept in the config folder.
pub struct Clients {
    path: PathBuf,
    list: Mutex<Vec<Stored>>,
}

impl Clients {
    pub fn load(path: PathBuf) -> Self {
        let list = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            list: Mutex::new(list),
        }
    }

    fn save(&self, list: &[Stored]) -> bool {
        serde_json::to_vec_pretty(list).is_ok_and(|json| write_private(&self.path, &json).is_ok())
    }

    /// The client a token belongs to.
    pub fn verify(&self, token: &str) -> Option<PairedClient> {
        let hashed = hash(token);
        self.list
            .lock()
            .unwrap()
            .iter()
            .find(|c| same(&c.token_hash, &hashed))
            .map(Stored::public)
    }

    /// Whether `id` is still paired (it may have been revoked since it said hello).
    pub fn contains(&self, id: &str) -> bool {
        self.list.lock().unwrap().iter().any(|c| c.id == id)
    }

    /// Pairs a client: its record kept, its token returned (once).
    fn add(&self, client: &ClientInfo) -> Result<(PairedClient, String), RpcError> {
        let token = random_hex(32);
        let stored = Stored {
            id: random_hex(8),
            name: tidy_name(&client.name),
            kind: client.kind,
            paired_at: now_ms(),
            token_hash: hash(&token),
        };
        let mut list = self.list.lock().unwrap();
        if list.len() >= MAX_CLIENTS {
            return Err(RpcError::new(
                code::INTERNAL,
                "too many paired clients: revoke one first",
            ));
        }
        list.push(stored.clone());
        if !self.save(&list) {
            list.pop();
            return Err(RpcError::new(
                code::INTERNAL,
                "the pairing couldn't be saved",
            ));
        }
        Ok((stored.public(), token))
    }

    pub fn list(&self) -> Vec<PairedClient> {
        self.list
            .lock()
            .unwrap()
            .iter()
            .map(Stored::public)
            .collect()
    }

    pub fn revoke(&self, id: &str) -> bool {
        let mut list = self.list.lock().unwrap();
        let before = list.clone();
        list.retain(|c| c.id != id);
        if list.len() == before.len() {
            return false;
        }
        if !self.save(&list) {
            *list = before;
            return false;
        }
        true
    }
}

/// Writes a file only this user can read, whole.
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

enum Waiting {
    OnUser,
    Approved { client_id: String, token: String },
    Denied,
}

struct Request {
    created: Instant,
    state: Waiting,
}

/// How the user is asked.
pub type Ask = Arc<dyn Fn(PairPrompt) -> tokio::task::JoinHandle<bool> + Send + Sync>;

/// What the user is shown.
#[derive(Clone, Debug)]
pub struct PairPrompt {
    pub name: String,
    pub kind: ClientKind,
    pub code: String,
}

/// Requests waiting on the user, and how to ask.
pub struct Pairing {
    clients: Arc<Clients>,
    requests: Arc<Mutex<HashMap<String, Request>>>,
    ask: Ask,
}

impl Pairing {
    pub fn new(clients: Arc<Clients>, ask: Ask) -> Self {
        Self {
            clients,
            requests: Arc::default(),
            ask,
        }
    }

    fn sweep(requests: &mut HashMap<String, Request>) {
        requests.retain(|_, r| r.created.elapsed() < WAIT_FOR);
    }

    /// Asks the user to pair `client`. The ticket's code is shown on both
    /// sides, so they know it's this client they're approving.
    pub fn request(&self, client: ClientInfo) -> Result<PairTicket, RpcError> {
        let request_id = random_hex(12);
        // Six digits, shown as "482 913".
        let n = u32::from_str_radix(&random_hex(4), 16).unwrap_or(0) % 1_000_000;
        let code = format!("{:03} {:03}", n / 1000, n % 1000);
        {
            let mut requests = self.requests.lock().unwrap();
            Self::sweep(&mut requests);
            let waiting = requests
                .values()
                .filter(|r| matches!(r.state, Waiting::OnUser))
                .count();
            if waiting >= MAX_WAITING {
                return Err(RpcError::new(
                    code::INTERNAL,
                    "too many pairing requests waiting; try again shortly",
                ));
            }
            requests.insert(
                request_id.clone(),
                Request {
                    created: Instant::now(),
                    state: Waiting::OnUser,
                },
            );
        }
        let prompt = PairPrompt {
            name: tidy_name(&client.name),
            kind: client.kind,
            code: code.clone(),
        };
        let asked = (self.ask)(prompt);
        let requests = Arc::clone(&self.requests);
        let clients = Arc::clone(&self.clients);
        let id = request_id.clone();
        tokio::spawn(async move {
            let approved = asked.await.unwrap_or(false);
            // Answered after the request ran out: its token could never be
            // handed over, so nothing is paired.
            if !requests.lock().unwrap().contains_key(&id) {
                return;
            }
            let state = if approved {
                match clients.add(&client) {
                    Ok((paired, token)) => {
                        eprintln!("pdd: paired {} ({})", paired.name, paired.id);
                        Waiting::Approved {
                            client_id: paired.id,
                            token,
                        }
                    }
                    Err(e) => {
                        eprintln!("pdd: pairing failed: {}", e.message);
                        Waiting::Denied
                    }
                }
            } else {
                Waiting::Denied
            };
            if let Some(request) = requests.lock().unwrap().get_mut(&id) {
                request.state = state;
            }
        });
        Ok(PairTicket { request_id, code })
    }

    /// Where a request stands. An approval's token is given once, then the
    /// request is gone.
    pub fn status(&self, request_id: &str) -> PairState {
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests);
        let Some(request) = requests.get(request_id) else {
            return PairState::Expired;
        };
        match &request.state {
            Waiting::OnUser => PairState::Pending,
            Waiting::Denied => {
                requests.remove(request_id);
                PairState::Denied
            }
            Waiting::Approved { .. } => match requests.remove(request_id).map(|r| r.state) {
                Some(Waiting::Approved { client_id, token }) => {
                    PairState::Approved { client_id, token }
                }
                _ => PairState::Expired,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pdd-pairing-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("pdd-clients.json")
    }

    fn pd() -> ClientInfo {
        ClientInfo {
            name: "pd on\nthis Mac\u{7}".into(),
            kind: ClientKind::Pd,
        }
    }

    fn answer(yes: bool) -> Ask {
        Arc::new(move |_| tokio::spawn(async move { yes }))
    }

    async fn settled(pairing: &Pairing, id: &str) -> PairState {
        for _ in 0..100 {
            match pairing.status(id) {
                PairState::Pending => tokio::task::yield_now().await,
                done => return done,
            }
        }
        PairState::Pending
    }

    #[tokio::test]
    async fn an_approved_client_gets_its_token_once_and_is_known_by_it() {
        let path = temp("approve");
        let clients = Arc::new(Clients::load(path.clone()));
        let pairing = Pairing::new(Arc::clone(&clients), answer(true));
        let ticket = pairing.request(pd()).unwrap();
        assert_eq!(ticket.code.len(), 7, "{}", ticket.code);
        let PairState::Approved { client_id, token } = settled(&pairing, &ticket.request_id).await
        else {
            panic!("not approved");
        };
        // Given once.
        assert_eq!(pairing.status(&ticket.request_id), PairState::Expired);
        let known = clients
            .verify(&token)
            .expect("the token is a paired client's");
        assert_eq!(known.id, client_id);
        assert_eq!(known.name, "pd onthis Mac", "control characters dropped");
        assert!(clients.verify("not the token").is_none());
        // Kept as a hash only, in a file only this user can read.
        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(!kept.contains(&token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Another run reads it back; revoking takes it away.
        let again = Clients::load(path.clone());
        assert!(again.verify(&token).is_some());
        assert!(again.revoke(&client_id));
        assert!(Clients::load(path.clone()).verify(&token).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn a_denied_client_gets_nothing() {
        let path = temp("deny");
        let clients = Arc::new(Clients::load(path.clone()));
        let pairing = Pairing::new(Arc::clone(&clients), answer(false));
        let ticket = pairing.request(pd()).unwrap();
        assert_eq!(
            settled(&pairing, &ticket.request_id).await,
            PairState::Denied
        );
        assert!(clients.list().is_empty());
        assert_eq!(pairing.status("made up"), PairState::Expired);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn requests_cant_pile_up_in_front_of_the_user() {
        let path = temp("pile");
        let clients = Arc::new(Clients::load(path.clone()));
        // Never answered.
        let ask: Ask = Arc::new(|_| tokio::spawn(std::future::pending()));
        let pairing = Pairing::new(clients, ask);
        for _ in 0..MAX_WAITING {
            pairing.request(pd()).unwrap();
        }
        assert!(pairing.request(pd()).is_err());
    }

    #[test]
    fn compares_without_shortcuts() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}
