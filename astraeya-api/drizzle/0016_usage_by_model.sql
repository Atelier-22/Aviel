ALTER TABLE "usage_records" ADD COLUMN "model" text;--> statement-breakpoint
CREATE INDEX "usage_records_user_model_idx" ON "usage_records" USING btree ("user_id","model","created_at");