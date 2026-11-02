-- The owner's sorting (E5). A mail moved to a category that keeps text may need its text fetched again: Needs sorting
-- and Personal hold none. This column carries the owner's choice through that fetch.
ALTER TABLE mail_pending ADD COLUMN owner_category_id INTEGER REFERENCES mail_categories (id) ON DELETE SET NULL;
