// ble.js — Couche Bluetooth (GATT) vers une radio Meshtastic.
// Adapté de : packages/transport-web-bluetooth/src/transport.ts (dépôt meshtastic/web, GPL-3.0)

export const SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
export const TORADIO_UUID = "f75c76d2-129e-4dad-a1dd-7866124401e7"; // écriture
export const FROMRADIO_UUID = "2c55e69e-4993-11ed-b878-0242ac120002"; // lecture
export const FROMNUM_UUID = "ed9da18c-a800-4f66-a670-aa7547e34453"; // notification

const RETRY_DELAY_MS = 750;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connexion BLE à une radio Meshtastic.
 *   onPacket(Uint8Array)  : appelé pour chaque message FromRadio brut reçu
 *   onDisconnect(raison)  : appelé quand la liaison tombe
 */
export class BleRadio {
  constructor({ onPacket, onDisconnect }) {
    this.onPacket = onPacket;
    this.onDisconnect = onDisconnect;
    this.device = null;
    this.toRadio = this.fromRadio = this.fromNum = null;
    this.reading = false;
    this.pendingRead = false;
    this.userClosing = false;
    // Une seule opération GATT à la fois : Chrome refuse les opérations
    // simultanées (« GATT operation already in progress »).
    this.gattChain = Promise.resolve();
  }

  /** Ouvre le sélecteur Bluetooth (doit suivre un clic) puis se connecte. */
  async requestAndConnect() {
    if (!("bluetooth" in navigator)) {
      throw new Error("Web Bluetooth indisponible : utilisez Chrome ou Edge (Android, Windows, macOS) en HTTPS.");
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    await this.connect();
    return this.device.name || "Radio Meshtastic";
  }

  /** Connexion GATT + récupération du service et des 3 caractéristiques. */
  async connect() {
    const server = await this.connectGatt();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch {
      throw new Error("Service Meshtastic introuvable : firmware trop ancien ou radio dans un autre mode.");
    }
    this.toRadio = await service.getCharacteristic(TORADIO_UUID);
    this.fromRadio = await service.getCharacteristic(FROMRADIO_UUID);
    this.fromNum = await service.getCharacteristic(FROMNUM_UUID);

    this.device.addEventListener("gattserverdisconnected", this.handleGattDisconnected);
    await this.fromNum.startNotifications();
    this.fromNum.addEventListener("characteristicvaluechanged", this.handleFromNum);
    this.readAll(); // des données attendent peut-être déjà
  }

  /** gatt.connect() avec une seconde tentative si l'erreur est passagère. */
  async connectGatt() {
    if (!this.device.gatt) throw new Error("La radio n'expose pas de serveur GATT. Réappairez-la.");
    try {
      return await this.device.gatt.connect();
    } catch (err) {
      const transient = err?.name === "NetworkError" || /connection attempt failed|gatt/i.test(err?.message ?? "");
      if (!transient) {
        throw new Error("Connexion Bluetooth impossible : radio allumée, à portée, et non connectée à un autre appareil ?");
      }
      await sleep(RETRY_DELAY_MS);
      return await this.device.gatt.connect();
    }
  }

  /** Sérialise les opérations GATT (lecture/écriture) dans une file. */
  gatt(op) {
    const run = this.gattChain.then(op, op);
    this.gattChain = run.catch(() => {});
    return run;
  }

  /** Écrit un message ToRadio (protobuf brut, sans en-tête 0x94C3 en BLE). */
  async write(bytes) {
    await this.gatt(() => this.toRadio.writeValue(bytes));
    this.readAll(); // la radio répond souvent juste après une écriture
  }

  /** Vide la file FromRadio : lit jusqu'à recevoir une valeur vide. */
  async readAll() {
    if (this.reading) {
      this.pendingRead = true; // une notification est arrivée pendant la lecture
      return;
    }
    this.reading = true;
    try {
      do {
        this.pendingRead = false;
        while (true) {
          const value = await this.gatt(() => this.fromRadio.readValue());
          if (value.byteLength === 0) break;
          this.onPacket(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
        }
      } while (this.pendingRead);
    } catch (err) {
      if (!this.userClosing) this.onDisconnect?.("erreur de lecture : " + err.message);
    } finally {
      this.reading = false;
    }
  }

  handleFromNum = () => this.readAll();

  handleGattDisconnected = () => {
    if (!this.userClosing) this.onDisconnect?.("liaison Bluetooth perdue");
  };

  /** Déconnexion volontaire. */
  disconnect() {
    this.userClosing = true;
    try {
      this.fromNum?.removeEventListener("characteristicvaluechanged", this.handleFromNum);
      this.device?.removeEventListener("gattserverdisconnected", this.handleGattDisconnected);
      this.device?.gatt?.disconnect();
    } finally {
      this.userClosing = false;
    }
  }
}
