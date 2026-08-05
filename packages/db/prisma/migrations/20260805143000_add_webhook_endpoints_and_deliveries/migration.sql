-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verification" TEXT NOT NULL DEFAULT 'token',
    "secret" TEXT,
    "template" TEXT NOT NULL DEFAULT '',
    "agent_id" TEXT NOT NULL,
    "routing" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 120,
    "subscription_state" JSONB,
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "discard_reason" TEXT,
    "event_type" TEXT,
    "dedupe_key" TEXT,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "headers" JSONB NOT NULL,
    "body_bytes" INTEGER NOT NULL,
    "rendered_text" TEXT,
    "render_warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_id" TEXT,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "replay_of_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_public_id_key" ON "webhook_endpoints"("public_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_project_id_idx" ON "webhook_endpoints"("project_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_agent_id_idx" ON "webhook_endpoints"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_project_id_slug_key" ON "webhook_endpoints"("project_id", "slug");

-- CreateIndex
CREATE INDEX "webhook_deliveries_agent_id_status_available_at_idx" ON "webhook_deliveries"("agent_id", "status", "available_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_project_id_created_at_idx" ON "webhook_deliveries"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_created_at_idx" ON "webhook_deliveries"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_dedupe_key_key" ON "webhook_deliveries"("endpoint_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

