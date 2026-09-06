# Payment verification and fulfillment

SSLCommerz IPN and browser callback requests are form encoded and receive a plain `200 OK` acknowledgement. EventGate stores the request before processing it, but never trusts its status, amount, transaction ID, or redirect destination.

For an IPN or success callback with both `tran_id` and `val_id`, EventGate calls SSLCommerz's validation endpoint. The response must be `VALID` or `VALIDATED` and match the saved merchant transaction ID, amount, and `BDT` currency. The provider's bank transaction ID is unique in the database.

Fulfillment runs in one serializable database transaction: it marks the verified attempt succeeded, changes the order to paid, converts the reservation to sold inventory (or atomically reacquires inventory after expiry), creates every ticket, and writes an audit log. Repeated notifications return `OK` without issuing duplicate tickets.

An expired, cancelled, or duplicate successful payment that cannot safely create tickets produces an approved automatic refund record for later provider-refund processing. A validation network/database failure leaves the attempt `UNKNOWN`; the durable `RECONCILE_PAYMENT` job retries validation using the recorded validation ID. No callback alone can change an order to paid.
