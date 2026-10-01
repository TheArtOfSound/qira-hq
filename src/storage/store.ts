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
        updated_at TEXT NOT NULL
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
    `);
  }

  beginEvent(eventId: string, eventType: string, now = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      INSERT INTO events(event_id,event_type,status,created_at,updated_at)
      VALUES(?,?,'processing',?,?) ON CONFLICT(event_id) DO NOTHING
    `).run(eventId, eventType, now, now);
    return result.changes === 1;
  }

  finishEvent(eventId: string, status: "processed" | "failed", result: unknown, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE events SET status=?, result=?, updated_at=? WHERE event_id=?")
      .run(status, JSON.stringify(result), now, eventId);
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
