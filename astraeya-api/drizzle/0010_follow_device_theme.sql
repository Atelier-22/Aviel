ALTER TABLE "user_settings" ALTER COLUMN "theme" SET DEFAULT 'system';--> statement-breakpoint
-- Light was the old default, not a choice most people made. Follow the device instead.
UPDATE "user_settings" SET "theme" = 'system' WHERE "theme" = 'light';