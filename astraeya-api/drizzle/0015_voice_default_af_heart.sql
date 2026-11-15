ALTER TABLE "user_settings" ALTER COLUMN "voice_name" SET DEFAULT 'af_heart';
--> statement-breakpoint
-- Everyone moves to af_heart: accounts that never chose (null) and accounts
-- saved with a browser voice name, which no longer exists here. Accounts
-- that somehow already hold one of Astraeya's own voices keep it.
UPDATE "user_settings" SET "voice_name" = 'af_heart'
WHERE "voice_name" IS NULL OR "voice_name" NOT IN ('af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore', 'af_sarah', 'af_nova', 'af_alloy', 'af_sky', 'af_jessica', 'af_river', 'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'am_michael', 'am_fenrir', 'am_puck', 'am_liam', 'am_echo', 'am_eric', 'am_onyx', 'am_adam', 'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel', 'en_GB-cori-high', 'en_GB-cori-medium', 'en_US-kristin-medium', 'en_US-kathleen-medium', 'en_US-ljspeech-high', 'en_US-john-medium', 'en_US-joe-medium', 'en_US-norman-medium');
