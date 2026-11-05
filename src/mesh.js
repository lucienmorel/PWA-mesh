// mesh.js — Protocole Meshtastic côté téléphone (« PhoneAPI ») : poignée de main,
// heartbeat, envoi/réception de texte, accusés de réception.
// Adapté du SDK du dépôt meshtastic/web (GPL-3.0) :
//   packages/sdk/src/core/client/MeshClient.ts
//   packages/sdk/src/core/client/handshake.ts
//   packages/sdk/src/core/packet-codec/decodePacket.ts
//   packages/sdk/src/core/queue/Queue.ts
//   packages/sdk/src/features/chat/application/SendTextUseCase.ts
//   apps/web/src/core/utils/channelUrl.ts + components/Dialog/QRDialog.tsx (partage de canal)

import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums, Channel, AppOnly } from "@meshtastic/protobufs";

export const BROADCAST = 0xffffffff;
export const CONFIG_NONCE = 69420; // étape 1 : config, canaux, myInfo
export const NODEDB_NONCE = 69421; // étape 2 : liste des nœuds
export const MAX_TEXT_BYTES = 228;
const HANDSHAKE_IDLE_TIMEOUT_MS = 15_000;
const HANDSHAKE_SETTLE_MS = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;
const FIRST_HEARTBEAT_NONCE = 2;
const ACK_TIMEOUT_MS = 60_000;

// Libellés français des erreurs de routage les plus courantes (Routing_Error).
const ROUTING_ERRORS_FR = {
  NO_ROUTE: "aucune route vers le destinataire",
  GOT_NAK: "refusé par un relais",
  TIMEOUT: "délai dépassé",
  NO_INTERFACE: "radio non disponible",
  MAX_RETRANSMIT: "pas de réponse après plusieurs renvois",
  NO_CHANNEL: "canal inconnu du destinataire",
  TOO_LARGE: "message trop gros",
  NO_RESPONSE: "pas de réponse",
  DUTY_CYCLE_LIMIT: "limite de temps d'émission atteinte",
  NOT_AUTHORIZED: "non autorisé",
  PKI_FAILED: "échec du chiffrement de bout en bout",
  PKI_UNKNOWN_PUBKEY: "clé publique du destinataire inconnue",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Identifiant de paquet aléatoire (cryptographique), comme generatePacketId(). */
export function generatePacketId() {
  const [seed] = crypto.getRandomValues(new Uint32Array(1));
  return Math.floor(seed * 2 ** -32 * 1e9) || 1;
}

/** Numéro de nœud → identifiant lisible « !a1b2c3d4 ». */
export const nodeId = (num) => "!" + (num >>> 0).toString(16).padStart(8, "0");

export class MeshClient {
  /** @param {(bytes: Uint8Array) => Promise<void>} write  écrit un ToRadio brut */
  constructor(write) {
    this.write = write;
    this.myNodeNum = 0;
    this.nodes = new Map(); // num → { num, longName, shortName }
    this.channels = new Map(); // index → { index, name, role, settings }
    this.loraConfig = null; // région, preset modem… (pour le partage de canal)
    this.listeners = {};
    this.pendingAcks = new Map(); // id → { resolve, reject, timer }
    this.recentIds = []; // anti-doublons
    this.heartbeatNonce = FIRST_HEARTBEAT_NONCE;
    this.heartbeatTimer = null;
    this.handshake = null; // { stage, resolve, reject, timer }
  }

  // ---------- petit système d'événements ----------
  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  emit(event, data) {
    for (const fn of this.listeners[event] ?? []) fn(data);
  }

  // ---------- envoi brut ----------
  /** Encode un ToRadio et l'écrit sur la radio. */
  sendToRadio(payloadVariant) {
    const msg = create(Mesh.ToRadioSchema, { payloadVariant });
    return this.write(toBinary(Mesh.ToRadioSchema, msg));
  }

  // ---------- poignée de main ----------
  /** Lance la poignée de main en deux étapes ; se résout une fois terminée. */
  configure() {
    this.stopHeartbeat();
    return new Promise((resolve, reject) => {
      this.handshake = { stage: "config", resolve, reject, timer: null, hasMyInfo: false };
      this.startStage("config");
    });
  }

  startStage(stage) {
    this.handshake.stage = stage;
    this.armHandshakeTimer();
    this.sendToRadio({
      case: "wantConfigId",
      value: stage === "config" ? CONFIG_NONCE : NODEDB_NONCE,
    }).catch((e) => this.failHandshake(e));
  }

  /** Échec si la radio se tait plus de 15 s pendant la poignée de main. */
  armHandshakeTimer() {
    clearTimeout(this.handshake?.timer);
    if (!this.handshake) return;
    this.handshake.timer = setTimeout(
      () => this.failHandshake(new Error(`La radio ne répond plus (étape ${this.handshake?.stage}).`)),
      HANDSHAKE_IDLE_TIMEOUT_MS,
    );
  }

  failHandshake(err) {
    if (!this.handshake) return;
    clearTimeout(this.handshake.timer);
    const { reject } = this.handshake;
    this.handshake = null;
    reject(err);
  }

  async onConfigComplete(nonce) {
    const hs = this.handshake;
    if (!hs) return;
    if (hs.stage === "config" && nonce === CONFIG_NONCE) {
      if (!hs.hasMyInfo) return this.failHandshake(new Error("Config reçue sans myInfo."));
      hs.stage = "settling";
      clearTimeout(hs.timer);
      // Pause + heartbeat entre les deux étapes, comme le client officiel.
      await sleep(HANDSHAKE_SETTLE_MS);
      await this.heartbeat().catch(() => {});
      await sleep(HANDSHAKE_SETTLE_MS);
      if (this.handshake === hs) this.startStage("nodedb");
    } else if (hs.stage === "nodedb" && nonce === NODEDB_NONCE) {
      clearTimeout(hs.timer);
      this.handshake = null;
      this.startHeartbeat();
      hs.resolve();
    }
  }

  // ---------- heartbeat ----------
  /** Signal de vie. Nonce ≥ 2 et toujours différent (voir handshake.ts). */
  heartbeat() {
    const nonce = this.heartbeatNonce;
    this.heartbeatNonce = nonce >= 0xffffffff ? FIRST_HEARTBEAT_NONCE : nonce + 1;
    return this.sendToRadio({ case: "heartbeat", value: create(Mesh.HeartbeatSchema, { nonce }) });
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---------- envoi d'un texte ----------
  /**
   * Envoie un message texte. Renvoie { id, ack } ; `ack` se résout quand la
   * radio confirme (paquet ROUTING_APP) ou se rejette (erreur / 60 s).
   */
  async sendText(text, { to = BROADCAST, channel = 0, wantAck = true } = {}) {
    if (!text) throw new Error("Message vide.");
    const payload = new TextEncoder().encode(text);
    if (payload.length > MAX_TEXT_BYTES) {
      throw new Error(`Message trop long : ${payload.length} octets (max ${MAX_TEXT_BYTES}).`);
    }
    const id = generatePacketId();
    const packet = create(Mesh.MeshPacketSchema, {
      from: this.myNodeNum,
      to,
      id,
      channel,
      wantAck,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
          payload,
        }),
      },
    });
    const ack = wantAck ? this.waitForAck(id) : Promise.resolve(id);
    await this.sendToRadio({ case: "packet", value: packet });
    return { id, ack };
  }

  waitForAck(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error("Pas d'accusé de réception (délai dépassé)."));
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(id, { resolve, reject, timer });
    });
  }

  settleAck(id, errorCode, from) {
    const p = this.pendingAcks.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingAcks.delete(id);
    if (errorCode === Mesh.Routing_Error.NONE) p.resolve({ id, from });
    else {
      const code = Mesh.Routing_Error[errorCode] ?? String(errorCode);
      p.reject(new Error(ROUTING_ERRORS_FR[code] ? `${ROUTING_ERRORS_FR[code]} (${code})` : code));
    }
  }

  // ---------- réception ----------
  /** Point d'entrée : un message FromRadio brut arrivé par Bluetooth. */
  handleFromRadio(bytes) {
    let msg;
    try {
      msg = fromBinary(Mesh.FromRadioSchema, bytes);
    } catch (e) {
      return this.emit("log", "Paquet indécodable ignoré");
    }
    const { case: kind, value } = msg.payloadVariant;
    if (this.handshake && kind && kind !== "packet") this.armHandshakeTimer();

    switch (kind) {
      case "myInfo":
        this.myNodeNum = value.myNodeNum;
        if (this.handshake) this.handshake.hasMyInfo = true;
        this.emit("myInfo", value);
        break;
      case "nodeInfo":
        this.upsertNode(value.num, value.user);
        break;
      case "channel":
        this.channels.set(value.index, {
          index: value.index,
          name: value.settings?.name || (value.index === 0 ? "Primaire" : `Canal ${value.index}`),
          role: value.role,
          settings: value.settings, // nom + clé (psk) : nécessaires au partage
        });
        this.emit("channels", this.activeChannels());
        break;
      case "config":
        if (value.payloadVariant.case === "lora") this.loraConfig = value.payloadVariant.value;
        break;
      case "configCompleteId":
        this.onConfigComplete(value);
        break;
      case "rebooted":
        this.emit("log", "La radio a redémarré");
        break;
      case "packet":
        this.handleMeshPacket(value);
        break;
    }
  }

  upsertNode(num, user) {
    if (!user) return;
    this.nodes.set(num, { num, longName: user.longName, shortName: user.shortName });
    this.emit("nodes", this.nodes);
  }

  activeChannels() {
    return [...this.channels.values()].filter((c) => c.role !== Channel.Channel_Role.DISABLED);
  }

  /** Nom lisible d'un nœud. */
  nodeName(num) {
    const n = this.nodes.get(num);
    return n?.longName || n?.shortName || nodeId(num);
  }

  handleMeshPacket(packet) {
    // Anti-doublons : la radio peut renvoyer le même paquet.
    const key = `${packet.from}:${packet.id}`;
    if (packet.id && this.recentIds.includes(key)) return;
    this.recentIds.push(key);
    if (this.recentIds.length > 200) this.recentIds.shift();

    if (packet.payloadVariant.case !== "decoded") return; // chiffré pour un autre canal
    const data = packet.payloadVariant.value;

    switch (data.portnum) {
      case Portnums.PortNum.TEXT_MESSAGE_APP:
        this.emit("message", {
          id: packet.id,
          from: packet.from,
          to: packet.to,
          channel: packet.channel,
          text: new TextDecoder().decode(data.payload),
          time: packet.rxTime ? new Date(packet.rxTime * 1000) : new Date(),
          snr: packet.rxSnr,
          rssi: packet.rxRssi,
        });
        break;
      case Portnums.PortNum.ROUTING_APP: {
        const routing = fromBinary(Mesh.RoutingSchema, data.payload);
        if (routing.variant.case === "errorReason") {
          this.settleAck(data.requestId, routing.variant.value, packet.from);
        }
        break;
      }
      case Portnums.PortNum.NODEINFO_APP:
        this.upsertNode(packet.from, fromBinary(Mesh.UserSchema, data.payload));
        break;
    }
  }

  // ---------- partage de canal ----------
  /**
   * Lien de partage Meshtastic (https://meshtastic.org/e/#…) pour les canaux
   * choisis : un ChannelSet (réglages des canaux + config LoRa) encodé en
   * base64url. L'appli officielle l'importe en scannant le QR code.
   * add = true : l'importateur AJOUTE les canaux au lieu de remplacer les siens.
   */
  channelShareUrl(indices, { add = false } = {}) {
    const settings = indices
      .map((i) => this.channels.get(i)?.settings)
      .filter(Boolean);
    const set = create(AppOnly.ChannelSetSchema, {
      settings,
      loraConfig: this.loraConfig ?? undefined,
    });
    const bin = toBinary(AppOnly.ChannelSetSchema, set);
    let b64 = "";
    for (const byte of bin) b64 += String.fromCharCode(byte);
    b64 = btoa(b64).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `https://meshtastic.org/e/${add ? "?add=true" : ""}#${b64}`;
  }

  /** Nettoyage à la déconnexion. */
  close(reason = "déconnecté") {
    this.stopHeartbeat();
    this.failHandshake(new Error(reason));
    for (const [, p] of this.pendingAcks) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pendingAcks.clear();
  }
}
