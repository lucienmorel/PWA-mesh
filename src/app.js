// app.js — Interface minimale : relie BleRadio (Bluetooth) et MeshClient (protocole) à la page.
import { BleRadio } from "./ble.js";
import { MeshClient, BROADCAST, MAX_TEXT_BYTES } from "./mesh.js";
import { Config } from "@meshtastic/protobufs";
import QRCode from "qrcode";

const $ = (id) => document.getElementById(id);
let radio = null;
let mesh = null;
let history = load();

// ---------- connexion ----------
$("connect").onclick = async () => {
  if (radio) return disconnect("Déconnecté");
  $("status").textContent = "Connexion…";
  mesh = new MeshClient((bytes) => radio.write(bytes));
  radio = new BleRadio({
    onPacket: (bytes) => mesh.handleFromRadio(bytes),
    onDisconnect: (reason) => disconnect("Perdu : " + reason),
  });
  mesh.on("channels", fillChannels).on("nodes", fillNodes).on("message", onMessage);

  try {
    const name = await radio.requestAndConnect(); // sélecteur Bluetooth
    $("status").textContent = "Configuration…";
    await mesh.configure(); // poignée de main
    $("status").textContent = "Connecté à " + name;
    $("me").textContent = "Moi : " + mesh.nodeName(mesh.myNodeNum);
    $("connect").textContent = "Déconnecter";
    enable(true);
  } catch (err) {
    disconnect(err.name === "NotFoundError" ? "Déconnecté" : "Erreur : " + err.message);
  }
};

function disconnect(label) {
  mesh?.close(label);
  radio?.disconnect();
  radio = mesh = null;
  $("status").textContent = label;
  $("me").textContent = "";
  $("connect").textContent = "Connecter la radio";
  enable(false);
}

function enable(on) {
  for (const id of ["channel", "dest", "share", "text"]) $(id).disabled = !on;
  if (!on && $("shareDialog").open) $("shareDialog").close();
  updateCount();
}

function fillChannels(channels) {
  const current = $("channel").value;
  $("channel").innerHTML = channels
    .sort((a, b) => a.index - b.index)
    .map((c) => `<option value="${c.index}">${esc(c.name)}</option>`).join("");
  if (channels.some((c) => String(c.index) === current)) $("channel").value = current;
}

function fillNodes(nodes) {
  const current = $("dest").value;
  $("dest").innerHTML = `<option value="broadcast">Tous (diffusion)</option>` +
    [...nodes.values()].filter((n) => n.num !== mesh.myNodeNum)
      .map((n) => `<option value="${n.num}">${esc(mesh.nodeName(n.num))}</option>`).join("");
  $("dest").value = [...$("dest").options].some((o) => o.value === current) ? current : "broadcast";
}

// ---------- réception ----------
function onMessage(msg) {
  if (msg.from === mesh.myNodeNum) return;
  add({ from: mesh.nodeName(msg.from), text: msg.text, channel: msg.channel, dm: msg.to !== BROADCAST, time: Date.now() });
}

// ---------- envoi ----------
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text || !mesh) return;
  const to = $("dest").value === "broadcast" ? BROADCAST : Number($("dest").value);
  const channel = Number($("channel").value) || 0;
  try {
    const { ack } = await mesh.sendText(text, { to, channel });
    $("text").value = "";
    updateCount();
    const entry = add({ from: "Moi", text, channel, dm: to !== BROADCAST, time: Date.now(), state: "envoi…" });
    ack.then(() => setState(entry, "✓ acquitté"), (err) => setState(entry, "✗ " + err.message));
  } catch (err) {
    $("status").textContent = err.message;
  }
};

$("text").oninput = updateCount;
function updateCount() {
  const n = new TextEncoder().encode($("text").value).length;
  $("count").textContent = `${n}/${MAX_TEXT_BYTES}`;
  $("send").disabled = !mesh || n === 0 || n > MAX_TEXT_BYTES;
}

// ---------- partage de canal ----------
let shareUrl = "";
$("share").onclick = () => {
  const current = Number($("channel").value) || 0;
  $("shareChannels").innerHTML = mesh.activeChannels()
    .map((c) => `<label><input type="checkbox" value="${c.index}" ${c.index === current ? "checked" : ""}> ${esc(c.name)}</label> `)
    .join("");
  $("lora").textContent = loraSummary(mesh.loraConfig);
  $("shareDialog").showModal();
  renderShare();
};
$("shareDialog").onchange = renderShare;

async function renderShare() {
  const indices = [...$("shareChannels").querySelectorAll("input:checked")].map((i) => Number(i.value));
  const add = document.querySelector("input[name=mode]:checked").value === "add";
  shareUrl = indices.length ? mesh.channelShareUrl(indices, { add }) : "";
  $("qr").innerHTML = shareUrl ? await QRCode.toString(shareUrl, { type: "svg", width: 240 }) : "Cochez un canal.";
}

$("copyLink").onclick = () => navigator.clipboard.writeText(shareUrl).catch(() => prompt("Lien :", shareUrl));

function loraSummary(lora) {
  if (!lora) return "";
  const region = Config.Config_LoRaConfig_RegionCode[lora.region];
  const preset = lora.usePreset ? Config.Config_LoRaConfig_ModemPreset[lora.modemPreset] : "personnalisé";
  return `Cette radio : région ${region}, preset ${preset}. L'autre radio doit avoir les mêmes.`;
}

// ---------- historique ----------
function add(entry) {
  history.push(entry);
  history = history.slice(-300);
  save();
  render();
  return entry;
}
function setState(entry, state) {
  entry.state = state;
  save();
  render();
}
function render() {
  $("messages").innerHTML = history.slice().reverse().map((m) => {
    const time = new Date(m.time).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const where = m.dm ? "MP" : "canal " + m.channel;
    return `<li>[${time}] <b>${esc(m.from)}</b> (${where}) : ${esc(m.text)} ${m.state ? `<i>${esc(m.state)}</i>` : ""}</li>`;
  }).join("");
}
function load() {
  try {
    const h = JSON.parse(localStorage.getItem("lora-messages") || "[]");
    return h.map((m) => (m.state === "envoi…" ? { ...m, state: "✗ interrompu" } : m));
  } catch { return []; }
}
function save() {
  try { localStorage.setItem("lora-messages", JSON.stringify(history)); } catch {}
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- PWA ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

render();
updateCount();
