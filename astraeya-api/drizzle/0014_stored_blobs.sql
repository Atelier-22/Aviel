CREATE TABLE "stored_blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
