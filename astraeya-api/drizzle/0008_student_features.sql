ALTER TABLE "messages" ADD COLUMN "document_text" text;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_content_search_idx" ON "messages" USING gin (to_tsvector('english', "content"));