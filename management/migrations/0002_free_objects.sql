CREATE TABLE IF NOT EXISTS free_objects (
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  key TEXT NOT NULL, data TEXT NOT NULL, content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0), PRIMARY KEY (visibility, key)
);
