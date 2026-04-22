CREATE INDEX "notifications_user_created_at_idx" ON "notifications" USING btree ("user_id","created_at");
