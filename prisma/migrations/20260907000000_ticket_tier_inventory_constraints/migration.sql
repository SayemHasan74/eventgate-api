ALTER TABLE "TicketTier"
  ADD CONSTRAINT "TicketTier_price_paisa_positive" CHECK ("pricePaisa" > 0),
  ADD CONSTRAINT "TicketTier_capacity_positive" CHECK ("capacity" > 0);
