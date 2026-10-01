// The local wallet page: served by the pewterdesk app on 127.0.0.1 so a
// browser-extension wallet can sign pewterdesk's API wallet approval. The app
// builds the approval and checks the signature; this page only asks the
// wallet. Text comes from the app in the user's language.

const ARBITRUM = 42161;
const providers = new Map();
let strings = {};
let busy = false;

const $ = (id) => document.getElementById(id);
const t = (key, vars = {}) =>
  (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));

function setStatus(text, kind = "") {
  const status = $("status");
  status.textContent = text;
  status.dataset.kind = kind;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(reply.error || t("failed"));
  return reply;
}

function messageOf(error) {
  if (error && typeof error.message === "string") return error.message;
  return t("failed");
}

async function connect(provider) {
  if (busy) return;
  busy = true;
  render();
  try {
    setStatus(t("connecting"));
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error(t("noAccount"));
    let chainId = Number.parseInt(await provider.request({ method: "eth_chainId" }), 16);
    if (chainId !== ARBITRUM) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${ARBITRUM.toString(16)}` }],
        });
        chainId = ARBITRUM;
      } catch {
        // Signing on the wallet's own chain works too.
      }
    }
    const typedData = await post("begin", { address, chainId });
    setStatus(t("sign"));
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(typedData)],
    });
    setStatus(t("sending"));
    await post("finish", { signature });
    setStatus(t("done"), "done");
    $("wallets").replaceChildren();
    return;
  } catch (error) {
    await post("cancel", {}).catch(() => undefined);
    setStatus(messageOf(error), "error");
  }
  busy = false;
  render();
}

function render() {
  const list = $("wallets");
  list.replaceChildren();
  for (const { info, provider } of providers.values()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = busy;
    if (typeof info.icon === "string" && info.icon.startsWith("data:image/")) {
      const icon = document.createElement("img");
      icon.src = info.icon;
      icon.alt = "";
      button.append(icon);
    }
    const name = document.createElement("span");
    name.textContent = info.name || t("injected");
    button.append(name);
    button.addEventListener("click", () => connect(provider));
    item.append(button);
    list.append(item);
  }
  if (providers.size === 0 && !busy) setStatus(t("noWallet"), "error");
}

async function start() {
  strings = await fetch("strings.json")
    .then((r) => r.json())
    .catch(() => ({}));
  document.title = t("pageTitle");
  $("title").textContent = t("title");
  $("lead").textContent = t("lead");
  $("note").textContent = t("note");

  // EIP-6963: every installed wallet announces itself.
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = event.detail ?? {};
    if (!info || !provider) return;
    providers.set(info.uuid || info.name, { info, provider });
    render();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Older wallets only inject window.ethereum.
  setTimeout(() => {
    if (providers.size === 0 && window.ethereum) {
      providers.set("injected", { info: { name: t("injected") }, provider: window.ethereum });
    }
    render();
  }, 600);
}

start();
