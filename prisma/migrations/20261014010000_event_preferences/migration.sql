CREATE TABLE "EventPreference" (
    "userId" UUID NOT NULL,
    "preferredCity" TEXT,
    "preferredCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "personalizationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventPreference_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "EventPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventPreference_category_limit" CHECK (cardinality("preferredCategories") <= 5)
);
