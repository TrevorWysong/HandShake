// The relay's one table, in SQLite (Node's built-in driver): each device it
// can wake -- how (its channel and address there) and the hash of the
// secret that lets the device change or forget its own row. Nothing about
// who the device belongs to, and nothing about any wake.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Channel = "webpush" | "apns" | "fcm";

export interface Device {
  id: string;
  channel: Channel;
  /// Where the channel reaches it: a Web Push subscription (JSON), an APNs
  /// device token, or an FCM registration token.
  address: string;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/// The database's file -- and the journal and write-ahead log SQLite makes
/// beside it, which take its permissions -- readable by the relay's own
/// account only: the addresses it holds reach people's devices. Its folder
/// is its own too: made so, or narrowed if it holds nothing but the
/// database. A folder others can read that holds other things too isn't the
/// relay's to narrow, so the relay won't start in one: give it a folder of
/// its own (`DB_PATH`, .env.example).
export function ownerOnly(path: string): void {
  const folder = dirname(path);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (statSync(folder).mode & 0o077) !== 0) {
    const name = basename(path);
    const dedicated = readdirSync(folder).every((entry) => entry === name || entry.startsWith(`${name}-`));
    if (!dedicated) throw new Error(`The push relay's database needs a folder of its own, readable by its account only: ${folder} is shared. Set DB_PATH to a file in a folder only the relay uses.`);
    chmodSync(folder, 0o700);
  }
  closeSync(openSync(path, "a", 0o600));
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    // An umask can't widen it, and a file from before is narrowed.
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") ownerOnly(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    )`);
  }

  /// A new device, and the secret only it will hold.
  register(channel: Channel, address: string): { id: string; secret: string } {
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO devices (id, secret_hash, channel, address, registered_at) VALUES (?, ?, ?, ?, ?)").run(id, hash(secret), channel, address, Date.now());
    return { id, secret };
  }

  /// The device, if `secret` is its own.
  authenticate(id: string, secret: string): Device | null {
    const row = this.db.prepare("SELECT id, channel, address, secret_hash FROM devices WHERE id = ?").get(id) as (Device & { secret_hash: string }) | undefined;
    if (!row || row.secret_hash !== hash(secret)) return null;
    return { id: row.id, channel: row.channel, address: row.address };
  }

  device(id: string): Device | null {
    const row = this.db.prepare("SELECT id, channel, address FROM devices WHERE id = ?").get(id) as Device | undefined;
    return row ?? null;
  }

  /// Gone: the device asked, or its channel said it no longer exists. Every
  /// token it handed out stops working.
  forget(id: string) {
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  }
}
