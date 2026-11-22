CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'login',
  account TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  time TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON submissions FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON submissions TO anon;
