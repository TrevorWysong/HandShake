# HandShake push relay

Wakes a customer's closed HandShake app when their store or driver changes their order, without learning who they are or what they ordered. docs/MOBILE.md, "Waking a closed app", has the design; this is the service.

```sh
cp .env.example .env
npm install
npm run keys >> .env     # its token key and a VAPID key -- keep them
npm start
npm test
```

Then set the network's `services.push_relay_url` to where the app reaches it (docs/DEPLOYMENT.md).

## What it does

- `POST /devices {channel, address}` registers a device: where its channel reaches it, a Web Push subscription, an APNs device token or an FCM registration token. It answers with the device's id, its secret, and twenty wake tokens. A Web Push subscription is accepted only for the browsers' own push services, over https (`WEB_PUSH_HOSTS`): the relay posts to it, so never to an address of the client's choosing. Registrations are limited per IPv4 address, or per IPv6 /64.
- `POST /devices/tokens {device, secret}` answers with twenty more.
- `DELETE /devices {device, secret}` forgets the device: every token it handed out stops working.
- `POST /wake {token}` wakes the device the token names, if it's this relay's, unexpired, and under the device's limits. Always answered alike. Each address may ask for so many wakes a minute (`WAKE_REQUESTS_PER_IP_PER_MINUTE`), whatever their tokens, and wakes are delivered a few at a time from a bounded queue: past it, they're dropped. So a flood of requests, invalid tokens included, can't exhaust the relay. Put a rate limit at the network's edge too, before the relay.
- `GET /config` names the channels it delivers on and its VAPID public key.

A wake is the same content-free push every time: an empty Web Push message, an APNs alert in the app's own words (`WAKE_TITLE`, `WAKE_BODY`), an FCM data message `{"wake": "1"}`. A device its channel says is gone is forgotten.

## What it keeps

One SQLite table: each device's id, a hash of its secret, its channel and address. Nothing about who the device belongs to, and nothing about any wake. How often each device was woken lately is kept in memory, for its limits: a restart forgets it, loosening a device's limits until they fill again. Anyone flooding a device still meets the per-address limit, and nothing outside lets them restart the relay.

## Channels

Each is on when its credentials are set (`.env.example`); a relay needs at least one.

- **Web Push**: a VAPID key (`npm run keys`) and a contact (`VAPID_SUBJECT`).
- **APNs**: a token key (.p8) from the Apple developer account, its key id, the team id and the app's bundle id. `APNS_SANDBOX=1` for development builds.
- **FCM**: the Firebase project's service account JSON.

APNs and FCM are tested against fakes of Apple's and Google's services, not yet against real devices: there's no phone build yet (docs/MOBILE.md).

## Keep safe

- `TOKEN_KEY`: replacing it voids every token devices hold (they fetch new ones, but orders already placed can't wake anyone).
- `VAPID_PRIVATE_KEY`: replacing it voids every browser's subscription; people turn waking on again.
- The database: losing it forgets every device, with the same effect.
