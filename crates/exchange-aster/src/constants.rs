pub struct Endpoints {
    pub rest: &'static str,
    /// The combined-streams endpoint; streams go in its `streams` query.
    pub ws: &'static str,
    /// Aster's web app API, for the list of asset logos only.
    pub web: &'static str,
    /// Where those logos are hosted. A listed logo elsewhere is ignored.
    pub logos: &'static str,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://fapi.asterdex.com",
    ws: "wss://fstream.asterdex.com/stream",
    web: "https://www.asterdex.com",
    logos: "https://static.astherus.finance",
};
