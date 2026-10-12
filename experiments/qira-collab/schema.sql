-- Qira Collab v0.1: isolated D1 schema. Apply with Wrangler D1 execute only to qira-collab-dev-db.
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),actor TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),created_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tokens_project ON tokens(project_id);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','blocked','review','done')),assignee TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id,updated_at);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),actor TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id,created_at);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),actor TEXT NOT NULL,type TEXT NOT NULL,ref_id TEXT,payload TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id,created_at);
