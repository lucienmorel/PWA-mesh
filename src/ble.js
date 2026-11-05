// ble.js — Couche Bluetooth (GATT) vers une radio Meshtastic.
// Adapté de : packages/transport-web-bluetooth/src/transport.ts (dépôt meshtastic/web, GPL-3.0)
// Ajouts par rapport à l'original : nouvelles tentatives pendant l'appairage
// et reconnexion automatique quand la liaison tombe.

export const SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
export const TORADIO_UUID = "f75c76d2-129e-4dad-a1dd-7866124401e7"; // écriture
export const FROMRADIO_UUID = "2c55e69e-4993-11ed-b878-0242ac120002"; // lecture
export const FROMNUM_UUID = "ed9da18c-a800-4f66-a670-aa7547e34453"; // notification

const CONNECT_ATTEMPTS = 6; // tentatives à la première connexion (~20 s)
const PAIRING_TIMEOUT_MS = 60_000; // temps laissé pour saisir le code PIN
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]; // après une coupure
const READ_RETRY_MS = 1000; // une lecture qui échoue est retentée…
const READ_RETRY_MAX = 30; // …pendant 30 s (le temps de taper le PIN d'appairage)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describe = (err) => (err?.name ? `${err.name}: ${err.message}` : String(err));

/** Vérifie que le navigateur et le Bluetooth de l'appareil sont utilisables. */
export async function checkBluetoothSupport() {
  if (!window.isSecureContext) return "La page doit être ouverte en HTTPS (ou sur localhost).";
  if (!navigator.bluetooth) {
    return "Navigateur non compatible : utilisez Chrome ou Edge (Android, Windows, macOS, ChromeOS). " +
      "Firefox, Safari, Brave et tous les navigateurs sur iPhone ne gèrent pas le Bluetooth web.";
  }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      return "Bluetooth désactivé ou absent sur cet appareil.";
    }
  } catch {}
  return null;
}

/**
 * Connexion BLE à une radio Meshtastic.
 *   onPacket(Uint8Array)       : un message FromRadio brut reçu
 *   onStatus(état, détail)     : "pairing" | "reconnecting" | "reconnected" | "lost"
 */
export class BleRadio {
  constructor({ onPacket, onStatus }) {
    this.onPacket = onPacket;
    this.onStatus = onStatus;
    this.device = null;
    this.toRadio = this.fromRadio = this.fromNum = null;
    this.ready = false; // service + caractéristiques prêts
    this.generation = 0; // change à chaque (re)connexion : coupe les anciennes boucles
    this.reading = false;
    this.pendingRead = false;
    this.userClosing = false;
    this.reconnecting = false;
    // Une seule opération GATT à la fois : Chrome refuse les opérations
    // simultanées (« GATT operation already in progress »).
    this.gattChain = Promise.resolve();
  }

  /** Ouvre le sélecteur Bluetooth (doit suivre un clic) puis se connecte. */
  async requestAndConnect() {
    const problem = await checkBluetoothSupport();
    if (problem) throw new Error(problem);
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    this.device.addEventListener("gattserverdisconnected", this.handleGattDisconnected);
    await this.connectWithRetry(CONNECT_ATTEMPTS);
    return this.device.name || "Radio Meshtastic";
  }

  /**
   * Plusieurs tentatives : juste après le choix de la radio, l'appairage
   * (code PIN) coupe souvent la liaison une première fois.
   */
  async connectWithRetry(attempts) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.connectOnce({ lastAttempt: i === attempts });
        return;
      } catch (err) {
        lastErr = err;
        if (err.fatal || this.userClosing) break;
        await sleep(Math.min(1000 * i, 4000));
      }
    }
    throw new Error(lastErr?.fatal ? lastErr.message : explain(lastErr));
  }

  /** Une tentative : GATT, service, 3 caractéristiques, appairage, notifications. */
  async connectOnce({ lastAttempt = true } = {}) {
    this.ready = false;
    const gen = ++this.generation;
    if (!this.device.gatt) throw fatal("La radio n'expose pas de serveur GATT. Réappairez-la.");

    const server = await this.device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (err) {
      // Sur Android, tant que l'appairage n'est pas fini, la découverte peut
      // revenir vide alors que la liaison tient : on ne conclut qu'au dernier essai.
      if (err?.name === "NotFoundError" && this.device.gatt.connected && lastAttempt) {
        throw fatal("Service Meshtastic introuvable : firmware trop ancien ou radio dans un autre mode.");
      }
      throw err; // liaison coupée pendant la découverte : on retentera
    }
    this.toRadio = await service.getCharacteristic(TORADIO_UUID);
    this.fromRadio = await service.getCharacteristic(FROMRADIO_UUID);
    this.fromNum = await service.getCharacteristic(FROMNUM_UUID);

    await this.waitUntilPaired(gen);
    this.fromNum.addEventListener("characteristicvaluechanged", this.handleFromNum);
    if (gen !== this.generation) throw new Error("connexion remplacée");
    this.gattChain = Promise.resolve();
    this.ready = true;
    this.readAll(); // des données attendent peut-être déjà
  }

  /**
   * Les caractéristiques Meshtastic sont chiffrées : la première lecture
   * déclenche l'appairage (code PIN) côté système. Tant qu'il n'est pas
   * terminé, lectures et notifications échouent. On attend ici, avant toute
   * poignée de main, au lieu de laisser la configuration expirer.
   */
  async waitUntilPaired(gen) {
    const deadline = Date.now() + PAIRING_TIMEOUT_MS;
    let announced = false;
    while (true) {
      try {
        const v = await this.fromRadio.readValue();
        if (v.byteLength) this.onPacket(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
        await this.fromNum.startNotifications();
        return;
      } catch (err) {
        if (!this.device.gatt.connected || gen !== this.generation) throw err; // liaison coupée : nouvel essai
        if (Date.now() > deadline) throw fatal("Appairage non terminé : le code PIN a-t-il été saisi ?");
        if (!announced) {
          announced = true;
          this.onStatus?.("pairing");
        }
        await sleep(1000);
      }
    }
  }

  /** Repart de zéro (nouvelle liaison + nouvelle session radio). */
  restart() {
    this.ready = false;
    this.generation++;
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {}
    void this.reconnectLoop();
  }

  /** Sérialise les opérations GATT (lecture/écriture) dans une file. */
  gatt(op) {
    const run = this.gattChain.then(op, op);
    this.gattChain = run.catch(() => {});
    return run;
  }

  /** Écrit un message ToRadio (protobuf brut, sans en-tête 0x94C3 en BLE). */
  async write(bytes) {
    if (!this.ready) throw new Error("Radio déconnectée (reconnexion en cours).");
    const ch = this.toRadio;
    await this.gatt(() => (ch.writeValueWithResponse ? ch.writeValueWithResponse(bytes) : ch.writeValue(bytes)));
    this.readAll(); // la radio répond souvent juste après une écriture
  }

  /**
   * Vide la file FromRadio : lit jusqu'à recevoir une valeur vide.
   * Une lecture qui échoue alors que la liaison tient (appairage en cours,
   * radio occupée) est retentée au lieu de tout couper.
   */
  async readAll() {
    if (this.reading) {
      this.pendingRead = true; // une notification est arrivée pendant la lecture
      return;
    }
    this.reading = true;
    const gen = this.generation;
    let failures = 0;
    try {
      do {
        this.pendingRead = false;
        while (this.ready && gen === this.generation) {
          let value;
          try {
            const ch = this.fromRadio;
            value = await this.gatt(() => ch.readValue());
            failures = 0;
          } catch (err) {
            if (!this.device?.gatt?.connected || gen !== this.generation) return; // la reconnexion prend le relais
            if (++failures > READ_RETRY_MAX) {
              this.device.gatt.disconnect(); // bloqué : on force une reconnexion propre
              return;
            }
            await sleep(READ_RETRY_MS);
            continue;
          }
          if (value.byteLength === 0) break;
          this.onPacket(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
        }
      } while (this.pendingRead && gen === this.generation);
    } finally {
      this.reading = false;
    }
  }

  handleFromNum = () => this.readAll();

  /** Liaison tombée (hors déconnexion volontaire) : reconnexion automatique. */
  handleGattDisconnected = () => {
    // Pas encore prête (tentative en cours ou entre deux tentatives) : la
    // boucle de connexion gère déjà l'erreur, ne pas en lancer une seconde.
    if (this.userClosing || !this.ready) return;
    this.ready = false;
    this.generation++;
    this.fromNum?.removeEventListener("characteristicvaluechanged", this.handleFromNum);
    void this.reconnectLoop();
  };

  async reconnectLoop() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.onStatus?.("reconnecting");
    try {
      for (const [i, delay] of RECONNECT_DELAYS_MS.entries()) {
        await sleep(delay);
        if (this.userClosing) return;
        try {
          await this.connectOnce({ lastAttempt: i === RECONNECT_DELAYS_MS.length - 1 });
          this.onStatus?.("reconnected");
          return;
        } catch (err) {
          if (err.fatal) break;
        }
      }
      this.onStatus?.("lost", "la radio ne répond plus (hors de portée, éteinte ou connectée à un autre appareil)");
    } finally {
      this.reconnecting = false;
    }
  }

  /** Déconnexion volontaire. */
  disconnect() {
    this.userClosing = true;
    this.ready = false;
    this.generation++;
    try {
      this.fromNum?.removeEventListener("characteristicvaluechanged", this.handleFromNum);
      this.device?.removeEventListener("gattserverdisconnected", this.handleGattDisconnected);
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {}
  }
}

function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

/** Message compréhensible à partir de l'erreur Bluetooth brute. */
function explain(err) {
  const raw = describe(err);
  if (/disconnected|NetworkError|connection attempt failed|GATT operation failed/i.test(raw)) {
    return "Connexion Bluetooth instable. Vérifiez que la radio est allumée, à portée, et qu'aucun autre " +
      "téléphone ou onglet n'y est connecté (fermez l'appli Meshtastic). Si un code PIN est demandé, " +
      `saisissez-le puis réessayez. (${raw})`;
  }
  return `Connexion impossible (${raw})`;
}
