# EventGate permissions

| Capability                                       | Attendee                      | Organizer                               | Admin                                                  |
| ------------------------------------------------ | ----------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Browse published events and tiers                | Yes                           | Yes                                     | Yes                                                    |
| Register through public password or Google login | Yes, creates attendee account | No self-promotion                       | No public admin registration                           |
| Update own profile                               | Yes                           | Yes                                     | Yes                                                    |
| Create and manage an event                       | No                            | Own events only                         | Yes, explicitly audited                                |
| Create and manage ticket tiers                   | No                            | Own events only                         | Yes, explicitly audited                                |
| Create, view, and cancel own pending orders      | Own orders only               | No                                      | View platform-wide                                     |
| Start payment and view own payment attempts      | Own orders only               | No                                      | View platform-wide                                     |
| View ticket and QR code                          | Own tickets only              | Check-in only, no attendee QR retrieval | Platform-wide when operationally necessary and audited |
| Check ticket in                                  | No                            | Own event only                          | Yes, audited                                           |
| Request whole-order refund                       | Eligible own paid orders only | No                                      | Review, approve, reject, and retry                     |
| View event sales reports                         | No                            | Own events only                         | Platform-wide                                          |
| Change user role/status                          | No                            | No                                      | Yes, with last-admin and organizer-event protections   |
| View payments and audit logs                     | No                            | Own event reports only                  | Yes                                                    |

Public registration always creates `ATTENDEE`. Only an active admin can promote an eligible attendee to `ORGANIZER`. Secure seed configuration creates admins.
