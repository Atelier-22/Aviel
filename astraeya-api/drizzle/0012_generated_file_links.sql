ALTER TABLE "conversations" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "generated_files" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_files_message_idx" ON "generated_files" USING btree ("message_id");