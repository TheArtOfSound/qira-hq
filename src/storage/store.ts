import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditEntry, BlockerInput, DedupeEvidence } from "../domain/types.js";
import { normalizeRootDomain } from "../domain/safety.js";

export interface OwnershipRecord {
  rootDomain: string;
  company: string;
  owner: string;
  claimedAt: string;
  expiresAt: string;
  status: "active" | "released";
  dedupe: DedupeEvidence;
}

export interface BlockerRecord extends BlockerInput {
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
}

export interface SurfaceRef {
  channelId: string;
  messageTs: string;
}

export interface PaymentRecord {
  paymentIntentId: string;
  opportunityId: string;
  closeWonAt?: string;
  fulfillmentStatus: "pending" | "failed" | "completed";
  fulfillmentJson?: unknown;
  lastError?: string;
}

export class CommandCenterStore {
  readonly db: DatabaseSync;

  constructor(path = "data/qira-command-center.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing','processed','failed')),
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS ownership (
        root_domain TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        owner TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','released')),
        dedupe_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blockers (
        blocker_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        source_system TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        evidence TEXT,
        success INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS slack_surfaces (
        surface_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(surface_kind, entity_id)
      );
      CREATE TABLE IF NOT EXISTS business_actions (
        action_key TEXT PRIMARY KEY,
        action_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
        result_json TEXT,
        updated_at TEXT NOT NULL,
        lease_expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS payment_handoffs (
        payment_intent_id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        close_won_at TEXT,
        fulfillment_status TEXT NOT NULL CHECK(fulfillment_status IN ('pending','failed','completed')),
        fulfillment_json TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS suppression_tallies (
        period TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('autoresponder','bounce','dsn')),
        count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(period,mailbox,kind)
      );
    `);
    this.ensureColumn("events", "lease_expires_at", "TEXT");
    this.ensureColumn("events", "attempts", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("business_actions", "lease_expires_at", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  beginEvent(eventId: string, eventType: string, now = new Date().toISOString(), leaseSeconds = 60): boolean {
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
    const result = this.db.prepare(`
      INSERT INTO events(event_id,event_type,status,created_at,updated_at,lease_expires_at,attempts)
      VALUES(?,?,'processing',?,?,?,1)
      ON CONFLICT(event_id) DO UPDATE SET
        status='processing', updated_at=excluded.updated_at,
        lease_expires_at=excluded.lease_expires_at, attempts=events.attempts+1
      WHERE events.status='failed' OR (events.status='processing' AND events.lease_expires_at <= excluded.updated_at)
    `).run(eventId, eventType, now, now, leaseExpiresAt);
    return result.changes === 1;
  }

  finishEvent(eventId: string, status: "processed" | "failed", result: unknown, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE events SET status=?, result=?, updated_at=?, lease_expires_at=NULL WHERE event_id=?")
      .run(status, JSON.stringify(result), now, eventId);
  }

  getEvent(eventId: string): { status: string; attempts: number; leaseExpiresAt?: string } | undefined {
    const row = this.db.prepare("SELECT status,attempts,lease_expires_at FROM events WHERE event_id=?").get(eventId) as { status: string; attempts: number; lease_expires_at: string | null } | undefined;
    return row ? { status: row.status, attempts: row.attempts, ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}) } : undefined;
  }

  beginBusinessAction(key: string, kind: string, entityId: string, now = new Date().toISOString(), leaseSeconds = 60): "started" | "completed" | "active" {
    const existing = this.db.prepare("SELECT status,lease_expires_at FROM business_actions WHERE action_key=?").get(key) as { status: string; lease_expires_at: string | null } | undefined;
    if (existing?.status === "completed") return "completed";
    if (existing?.status === "processing" && existing.lease_expires_at && existing.lease_expires_at > now) return "active";
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
    const result = this.db.prepare(`
      INSERT INTO business_actions(action_key,action_kind,entity_id,status,updated_at,lease_expires_at)
      VALUES(?,?,?,'processing',?,?) ON CONFLICT(action_key) DO UPDATE SET
        status='processing',updated_at=excluded.updated_at,lease_expires_at=excluded.lease_expires_at
      WHERE business_actions.status='failed' OR business_actions.lease_expires_at <= excluded.updated_at
    `).run(key, kind, entityId, now, leaseExpiresAt);
    return result.changes === 1 ? "started" : "active";
  }

  finishBusinessAction(key: string, status: "completed" | "failed", result: unknown, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE business_actions SET status=?,result_json=?,updated_at=?,lease_expires_at=NULL WHERE action_key=?")
      .run(status, JSON.stringify(result), now, key);
  }

  claimPayment(paymentIntentId: string, opportunityId: string, now = new Date().toISOString()): { isNew: boolean; conflict: boolean; record: PaymentRecord } {
    const result = this.db.prepare(`
      INSERT INTO payment_handoffs(payment_intent_id,opportunity_id,fulfillment_status,updated_at)
      VALUES(?,?,'pending',?) ON CONFLICT(payment_intent_id) DO NOTHING
    `).run(paymentIntentId, opportunityId, now);
    const record = this.getPayment(paymentIntentId);
    if (!record) throw new Error("Payment handoff record could not be loaded");
    return { isNew: result.changes === 1, conflict: record.opportunityId !== opportunityId, record };
  }

  getPayment(paymentIntentId: string): PaymentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_handoffs WHERE payment_intent_id=?").get(paymentIntentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      paymentIntentId: String(row.payment_intent_id), opportunityId: String(row.opportunity_id),
      fulfillmentStatus: String(row.fulfillment_status) as PaymentRecord["fulfillmentStatus"],
      ...(row.close_won_at ? { closeWonAt: String(row.close_won_at) } : {}),
      ...(row.fulfillment_json ? { fulfillmentJson: JSON.parse(String(row.fulfillment_json)) } : {}),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    };
  }

  markPaymentWon(paymentIntentId: string, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE payment_handoffs SET close_won_at=COALESCE(close_won_at,?),updated_at=? WHERE payment_intent_id=?")
      .run(now, now, paymentIntentId);
  }

  markFulfillment(paymentIntentId: string, status: "failed" | "completed", result: unknown, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE payment_handoffs SET fulfillment_status=?,fulfillment_json=?,last_error=?,updated_at=? WHERE payment_intent_id=?")
      .run(status, status === "completed" ? JSON.stringify(result) : null, status === "failed" ? String(result) : null, now, paymentIntentId);
  }

  incrementSuppression(period: string, mailbox: string, kind: "autoresponder" | "bounce" | "dsn", now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO suppression_tallies(period,mailbox,kind,count,updated_at) VALUES(?,?,?,1,?)
      ON CONFLICT(period,mailbox,kind) DO UPDATE SET count=suppression_tallies.count+1,updated_at=excluded.updated_at
    `).run(period, mailbox, kind, now);
  }

  getSuppressionTotals(period: string): Record<"autoresponder" | "bounce" | "dsn", number> {
    const totals = { autoresponder: 0, bounce: 0, dsn: 0 };
    const rows = this.db.prepare("SELECT kind,SUM(count) AS count FROM suppression_tallies WHERE period=? GROUP BY kind").all(period) as Array<{ kind: keyof typeof totals; count: number }>;
    for (const row of rows) totals[row.kind] = Number(row.count);
    return totals;
  }

  eventCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count);
  }

  claimProspect(input: {
    company: string;
    rootDomain: string;
    owner: string;
    expiresAt: string;
    dedupe: DedupeEvidence;
    now?: string;
  }): { claimed: boolean; record: OwnershipRecord } {
    const domain = normalizeRootDomain(input.rootDomain);
    const now = input.now ?? new Date().toISOString();
    if (!input.dedupe.gmailClear || !input.dedupe.closeClear) {
      throw new Error("Prospect claim requires clear Gmail and Close dedupe evidence");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT INTO ownership(root_domain,company,owner,claimed_at,expires_at,status,dedupe_json)
        VALUES(?,?,?,?,?,'active',?)
        ON CONFLICT(root_domain) DO UPDATE SET
          company=excluded.company, owner=excluded.owner, claimed_at=excluded.claimed_at,
          expires_at=excluded.expires_at, status='active', dedupe_json=excluded.dedupe_json
        WHERE ownership.status='released' OR ownership.expires_at <= ?
      `).run(domain, input.company, input.owner, now, input.expiresAt, JSON.stringify(input.dedupe), now);
      const row = this.db.prepare("SELECT * FROM ownership WHERE root_domain=?").get(domain) as Record<string, unknown>;
      this.db.exec("COMMIT");
      return { claimed: result.changes === 1 || row.owner === input.owner, record: this.mapOwnership(row) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseProspect(rootDomain: string, actor: string): boolean {
    const domain = normalizeRootDomain(rootDomain);
    const result = this.db.prepare("UPDATE ownership SET status='released' WHERE root_domain=? AND owner=? AND status='active'")
      .run(domain, actor);
    return result.changes === 1;
  }

  getOwnership(rootDomain: string): OwnershipRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ownership WHERE root_domain=?").get(normalizeRootDomain(rootDomain)) as Record<string, unknown> | undefined;
    return row ? this.mapOwnership(row) : undefined;
  }

  private mapOwnership(row: Record<string, unknown>): OwnershipRecord {
    return {
      rootDomain: String(row.root_domain), company: String(row.company), owner: String(row.owner),
      claimedAt: String(row.claimed_at), expiresAt: String(row.expires_at),
      status: String(row.status) as OwnershipRecord["status"],
      dedupe: JSON.parse(String(row.dedupe_json)) as DedupeEvidence,
    };
  }

  upsertBlocker(input: BlockerInput, now = new Date().toISOString()): { isNew: boolean; record: BlockerRecord } {
    const result = this.db.prepare(`
      INSERT INTO blockers(blocker_key,payload_json,first_seen,last_seen,occurrence_count)
      VALUES(?,?,?, ?,1)
      ON CONFLICT(blocker_key) DO UPDATE SET
        payload_json=excluded.payload_json,last_seen=excluded.last_seen,
        occurrence_count=blockers.occurrence_count+1
    `).run(input.key, JSON.stringify(input), now, now);
    const row = this.db.prepare("SELECT * FROM blockers WHERE blocker_key=?").get(input.key) as Record<string, unknown>;
    return {
      isNew: result.changes === 1 && Number(row.occurrence_count) === 1,
      record: {
        ...(JSON.parse(String(row.payload_json)) as BlockerInput),
        firstSeen: String(row.first_seen), lastSeen: String(row.last_seen),
        occurrenceCount: Number(row.occurrence_count),
      },
    };
  }

  blockerCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM blockers").get() as { count: number }).count);
  }

  recordAudit(entry: AuditEntry, now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO audit_log(occurred_at,actor,action,source_system,entity_type,entity_id,before_json,after_json,evidence,success,error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(now, entry.actor, entry.action, entry.sourceSystem, entry.entityType, entry.entityId,
      JSON.stringify(entry.before), JSON.stringify(entry.after), entry.evidence ?? null, entry.success ? 1 : 0, entry.error ?? null);
  }

  auditCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count);
  }

  getSurface(kind: string, entityId: string): SurfaceRef | undefined {
    const row = this.db.prepare("SELECT channel_id,message_ts FROM slack_surfaces WHERE surface_kind=? AND entity_id=?")
      .get(kind, entityId) as { channel_id: string; message_ts: string } | undefined;
    return row ? { channelId: row.channel_id, messageTs: row.message_ts } : undefined;
  }

  saveSurface(kind: string, entityId: string, ref: SurfaceRef, now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO slack_surfaces(surface_kind,entity_id,channel_id,message_ts,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(surface_kind,entity_id) DO UPDATE SET
        channel_id=excluded.channel_id,message_ts=excluded.message_ts,updated_at=excluded.updated_at
    `).run(kind, entityId, ref.channelId, ref.messageTs, now);
  }
}
