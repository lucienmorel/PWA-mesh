# LoRa Messager

PWA qui envoie et reçoit des messages LoRa via une radio Meshtastic connectée en Bluetooth.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # dossier dist/ à déployer (Netlify : netlify.toml prêt)
```

- `src/ble.js` : connexion Bluetooth à la radio
- `src/mesh.js` : protocole Meshtastic (poignée de main, envoi, réception, accusés, partage de canal)
- `src/app.js` : interface

Chrome ou Edge uniquement (pas d'iPhone), en HTTPS. Une seule connexion Bluetooth par radio.
Licence GPL-3.0 (code adapté de github.com/meshtastic/web).
