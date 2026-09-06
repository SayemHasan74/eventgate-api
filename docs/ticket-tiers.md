# Ticket-tier rules

Ticket tiers are managed through `/api/v1/organizer/events/:eventId/ticket-tiers`. Only the event owner or an administrator can access them, and tiers can be changed only while the event is a draft.

Each tier stores a BDT price in integer paisa, capacity, reserved quantity, sold quantity, and a sales window. The API requires a positive price and capacity, a future sales start, an end after the start, and a sales end no later than the event’s start.

PostgreSQL enforces the critical inventory constraints:

```text
pricePaisa > 0
capacity > 0
reservedQuantity >= 0
soldQuantity >= 0
reservedQuantity + soldQuantity <= capacity
salesEndAt > salesStartAt
```

After an order exists, a tier’s name, price, and sales start are locked; capacity may only increase. A tier with order history cannot be deleted, so organizers close its sales window instead. Eligible deletion is a soft deletion. Creation, edit, and deletion each write an audit record.

Run `prisma migrate deploy` before the PostgreSQL integration test. `tests/integration/ticket-tiers.integration.test.ts` verifies ownership, API inventory protection, order-history locks, and the database-level inventory constraint with a real `TEST_DATABASE_URL`.
