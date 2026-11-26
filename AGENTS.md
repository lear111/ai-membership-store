# Instructions for Codex and contributors

## Current repository baseline

The implementation snapshot is maintained in [docs/00-project-status.md](docs/00-project-status.md). The implementation baseline is `main` at `7eadad7af03c96799bfdefba715d443212a08b05`, including merged PR #57 (T27.3 one-off Windows backup tooling). The application baseline remains PR #55 at `408b3b276a26abe97be2b519f5d8d9f19fc68682`. T20/T21 order centers, T22 storefront ordering, customer subscription reads, ordinary registration, T25 invitation-based customer claiming, T26 10,000-character textarea support, ADMIN storefront self-service, WeChat payment claims, storefront redesign and product covers are implemented. T25 adds migration 15; T26 changes application validation and request limits without a migration. No merge implies production deployment. T27.4 backup preparation checks are next; actual production backup, verified restore and separate rollout authorization remain required. See [T27](docs/36-t27-batch-release.md). This does not establish the state of any running server.

Use the status index for what is implemented and the linked task-specific contracts for behavior. Earlier phase sections below preserve their original scope and safeguards; their exclusions do not undo subsequently merged features. An unresolved business-rule conflict still needs the owner's decision. Preserve all applicable privacy, authorization, data-protection and deployment constraints.

## Before changing code

1. Read this file, docs/00-project-status.md, and every document listed in the README documentation reading order. Check the current branch and relevant PR before selecting work.
2. Use the current status index and applicable task-specific contracts together. For UI work, follow docs/08-interface-specification.md and its later implementation sections as the approved source of truth. Treat explicitly historical phase exclusions as historical.
3. Check the existing repository before creating or replacing files. Preserve user changes.
4. Work on only the explicitly requested task or the next not-yet-completed task in the roadmap. Do not implement the entire roadmap in one run.
5. If a requirement is ambiguous or conflicts with the current implementation, stop and report the exact decision needed instead of inventing business rules.

## Working style

- Keep the architecture a modular monolith for the MVP.
- Prefer small, reviewable changes.
- Before each phase, state the task, expected files, and acceptance criteria.
- After each task, run the relevant tests, type checks, lint, and build commands that exist.
- Report changed files, commands executed, results, known gaps, and the next recommended task.
- Wait for approval before starting the next substantial task.
- The owner assigns project design and status documentation maintenance to ChatGPT. Follow the approved task contract; Codex implements and tests, reports discrepancies, changed files, exact commands/results and remaining gaps, and does not independently revise product/design contracts unless explicitly instructed.
- After feature review/merge, the documentation maintainer reconciles docs/00-project-status.md, the roadmap and affected contracts from verified evidence. Keep historical test results tied to their reported scope; do not describe them as a new run or proof of deployment.

## Product and workflow constraints

- The MVP is a manual-fulfillment reseller storefront, not an automated supplier integration.
- Customer payment verification, supplier transfer, and service fulfillment are separate states.
- Supplier request/completion email and supplier-transfer recordkeeping remain planned. When that workflow is separately implemented, send the supplier request only after administrator payment verification, keep the transfer manual, and send customer completion email only after the operator verifies fulfillment. Do not infer that these integrations already exist.
- Planned order-based subscription renewal creates a new order and is not an automatic recurring charge. Existing Phase 2 direct subscription renewal is a compatibility workflow with its own contract; do not remove it or treat it as an implemented order-renewal flow.
- Do not assume that a renewal extends an existing expiry date by a fixed number of days. The operator must record the expiry date confirmed by the supplier until a product-specific renewal rule is verified.
- Do not add a real payment gateway or supplier API integration unless the user explicitly approves the provider, credentials, product eligibility, and integration scope.

## UI surfaces and prototype constraints

- The customer storefront and the unified owner/admin console are the only two application surfaces.
- The owner/admin console combines merchant operations and administrator functions; do not create separate merchant and administrator portals.
- Follow docs/08-interface-specification.md for layout, responsive behavior, navigation, and page content.
- The original UI prototype used Mock data. The real storefront, order centers, products, customers, settings and subscription views must retain their API integration. The operating overview and remaining prototype demonstrations retain their documented Mock boundaries; clearly label simulated actions.
- Never connect mock buttons to real payment, refund, settlement, supplier, or email operations.
- Do not add procurement-cost, gross-profit, merchant-wallet, or merchant-withdrawal UI to the first version.

## Security and privacy constraints

- Never commit real API keys, SMTP passwords, access tokens, private keys, customer data, supplier secrets, or production configuration.
- Provide .env.example with placeholders only. Ensure .env and local secret files are ignored by Git.
- Never log passwords, one-time passwords, 2FA codes, recovery codes, payment credentials, or full sensitive form values.
- The MVP must not collect account passwords, one-time passwords, 2FA codes, recovery codes, session cookies, or other authentication secrets in ordinary order forms or email.
- Product-specific forms may collect only necessary, non-sensitive identifiers and contact details. If the supplier claims a secret is required, stop and request a separate security and authorization design; do not quietly add a password field.
- Do not automate login to third-party AI services or bypass their access controls.
- Use role-based access control for administrator functions.
- Verify ownership before showing an order or subscription to a customer.
- Validate all input on the server. Do not trust prices, roles, order statuses, or payment states sent by the browser.
- Use parameterized database access through the ORM, secure password hashing, HTTP-only session cookies, CSRF protection where applicable, and rate limits for authentication endpoints.
- Record important administrator actions in an audit log.
- Minimize customer data collection and define a retention/deletion process.

## Engineering constraints

- Store money as integer minor units (for example, CNY fen), never floating-point values.
- Store timestamps in UTC and render them in the configured business timezone (initial default: Asia/Shanghai).
- Use database transactions for order creation, payment verification, and membership updates where multiple records must remain consistent.
- When email delivery is implemented, make it retryable and idempotent and persist an email/outbox record before sending. These components are not implemented by the current baseline.
- Do not mark an email as delivered merely because an attempt was queued.
- Do not mark a customer payment as paid based only on a screenshot or a client-side claim. The administrator must verify the actual transaction in the relevant payment account or provider console.
- Keep secrets out of API responses and frontend bundles.
- Add tests for authorization, state transitions, duplicate actions, and failure paths.

## T23.1 production application profile

- Use [the clean installation guide](docs/31-production-clean-install.md). Package the reviewed release artifacts and use a fresh MySQL schema and private image directories.
- Keep the production API on loopback with runtime-only credentials. Migration, first-ADMIN bootstrap and backup credentials belong in separate contexts. Run first-ADMIN bootstrap explicitly against the named, migrated and empty target before opening registration.
- Review and authorization for actual production operations remain part of the separately scoped deployment stages.

## Definition of done

A task is complete only when:

1. Its acceptance criteria are met.
2. Relevant tests and build checks pass, or failures are explicitly explained.
3. No secrets or real customer data are added.
4. Documentation is updated when needed.
5. The final report identifies any manual setup still required.


## Historical stage: Task 1.2 local-only operating constraints

This section records the original local milestone. T22 and later storefront tasks supersede its lack of customer browsing, registration and order placement. Its financial, privacy and data-preservation rules remain applicable; an offline storefront order is not a payment-provider checkout.

- Follow docs/10-local-operations-mvp.md, docs/04-data-model.md, and docs/05-api-contract.md as the current source of truth for Task 1.2.
- This milestone is a local offline customer/order/subscription manager, not a public online store.
- The original Task 1.2 offline-order source design is superseded by the order-model override below. Payment-provider APIs/webhooks, settlement, funds holding and withdrawal remain outside this milestone and the current implementation.
- Never send email in Task 1.2. Invitation links are generated for the admin to copy manually. No SMTP package, email outbox, or email worker.
- The app must make clear that localhost invitation links cannot be opened by external customers.
- Pending-activation customers may own orders and subscriptions. Do not gate admin operations on customer activation status.
- Do not create fake orders/payment records for MANUAL_GRANT or HISTORICAL_IMPORT subscriptions.
- Payment status must be based on recorded/confirmed PaymentTransaction rows. Fulfillment status is a separate dimension. Do not directly trust a browser-supplied status.
- Offline refund is only recorded after private agreement; mark it confirmed only after the owner has actually returned funds externally. The application never moves money.
- Keep the app bound to loopback during local development. Do not deploy or expose it publicly.
- Do not add supplier cost, supplier transfer, merchant wallet, multi-merchant, or profit accounting features.

## Historical stage: Phase 2 owner-approved override

The Phase 2 subscription services remain a compatibility path. Its original ADMIN/SYSTEM-only source model and exclusion of order APIs are superseded where the later order foundation and T19 contracts add ORDER subscriptions and fulfillment. Customer subscription reads are now implemented. Preserve committed historical SQL and use the migration tool to apply only pending migrations on an existing target; fresh isolated verification still applies the complete reviewed migration chain. Do not replace current order fulfillment with direct subscription creation.

- Phase 2 follows docs/14-user-subscription-core.md for user names and subscriptions. This explicitly supersedes older subscription-renewal/order linkage rules for this phase.
- Only ADMIN can create/manage subscriptions. Direct renewal changes the existing subscription, using a manually entered expiry; never create an order/payment or infer duration.
- Keep username separate from private adminLabel. Customer responses must exclude adminLabel; do not add a new activation or username editing flow.
- Persist frozen product/form snapshots and validate changes against the subscription's own snapshot.
- ADMIN/SYSTEM sources and ACTIVE/TERMINATED states only. Preserve all historical event types/rows and restrictive references.
- Legacy ORDER/MANUAL_GRANT/HISTORICAL_IMPORT sources migrate to ADMIN without changing creators, IDs, dates, price or status. Any SUSPENDED row blocks migration before persistent changes; report its count and IDs for operator decision.
- Versioned migration and tests run on isolated databases only during implementation. Never migrate/reset the development database or edit its .env.
- Subscription writes, events, sanitized audits and idempotency responses commit atomically. Enforce optimistic version checks and database-time expiry checks, including races with the minute expiry worker.
- No order/payment, email/SMTP, notifications, verification codes, upstream API or API-key feature in this phase. Stop at the new PR for review.

## Historical stage: Order/subscription model stage 1 override (2026-11-18)

This was the schema-only stage. The later order services and T19 fulfillment are now merged; the stage's prohibition on implementing them is not a current missing-feature declaration. Its immutable-history and migration safeguards still apply.

- Follow docs/15-order-subscription-foundation.md for the separately authorized additive database model stage. Future business uses order → confirmed full offline payment → fulfillment → order-linked subscription; this supersedes Phase 2 direct creation/renewal for the future workflow.
- This stage implements schema, versioned migration, compatibility tests and documentation only. Do not implement new pages, order/payment APIs, calendar calculations, renewal jobs or fulfillment services.
- Final Order sources are USER/ADMIN/SYSTEM_RENEWAL only. Retain ADMIN/SYSTEM subscriptions, old non-source columns/states, and nullable legacy subscription sourceOrderId; do not invent orders/payments. Order source is immutable and every order rejects DELETE/REPLACE. Migration ten removes retired-source compatibility and refuses existing retired-source rows; development cleanup requires separate authorization.
- Unknown historical periods/anchors/order forms stay NULL. Never infer from termLabel, invent source orders/payments or alter original snapshots.
- Only isolated databases may be migrated/tested during development. Preserve the original checkout, .env, running services and data volume. Review and backup precede any separately authorized development migration.

## Final source override (2026-11-18)

- OFFLINE_MANUAL is retired. Remove it from the current Prisma enum and final database CHECK/trigger definitions; retain immutable historical migration SQL.
- Only random isolated migration fixtures may be cleaned in this task. Do not connect to the development database, inspect its orders, remove its records or modify its volume/.env. Report its order counts/relationships as uninspected.
- Nullable source storage is deliberate to reject non-strict implicit ENUM defaults; a required-source CHECK and INSERT Trigger forbid persisted NULL. Future order services must explicitly require a source from trusted server context.


## Current storefront and order constraints (through PR #46)

- T20 `/admin/orders` and T21 `/account/orders` are real API-backed order centers. The account order center manages the signed-in user's existing orders; creation remains in the storefront purchase flow. Do not restore Mock order actions.
- T22 public catalog, detail, protected purchase form and order submission are merged. Guests may browse; purchase requires an ACTIVE session. After the explicit purchase action, ACTIVE CUSTOMER and ADMIN users may load the safe purchase form. Preserve the validated login/registration return path, product-version check and original-request idempotent retry.
- Public catalog DTOs must exclude formSchema/defaultValue, internal fields and storage keys. Customer-facing order DTOs use frozen snapshots and hide internalNote, creator, audit, revision and payment/refund attempt details. Preserve own-record and hidden/missing 404 behavior.
- T24.4B.1 allows ACTIVE ADMIN users to buy and manage only their own storefront orders and view their own subscriptions through the customer-facing routes. Their self-service orders have server-derived ADMIN source/actor records. This does not broaden storefront ownership checks or ADMIN management permissions.
- T24.4B.2 registration creates an ACTIVE CUSTOMER and Session using the existing safe auth response. Email ownership is unverified; retain the documented CSRF, duplicate-email and registration-limit behavior. Do not add email verification or a new account flow as part of unrelated work.
- Customer subscription list/detail reads are implemented. Keep their safe frozen projections and visible source-order rules. Customer/order-based renewal, automatic recurring charges and SYSTEM_RENEWAL execution remain separate future work; preserve the existing compatibility subscription APIs.
- T24.0 nine-digit order numbers are display/search identifiers. Keep UUID route identity, authorization, historical number compatibility and raw copy semantics.
- T24.1 administrator WeChat settings and T24.2 customer payment claims are implemented. A claim only moves an eligible order to PENDING_VERIFICATION; it creates no confirmed receipt, paid timestamp, subscription or entitlement. Actual payment/refund facts still come from administrator verification. Proof uploads and customer refund-request workflows remain unimplemented.
- Customer refund status is order-level only. REFUND_PENDING means `待退款`, not proof that an external transfer has started; REFUNDED appears only after ADMIN confirms actual refund completion. Merchant remarks remain plain text.
- T24.5A storefront redesign and T24.5B covers are merged. Preserve the mobile two-column catalog, 4:3 cover container, missing/error placeholder and compact purchase summary. Cover writes update the product version and audit atomically after file persistence; public reads resolve only the current cover of a listed, unarchived product. Keep cover and QR directories separate, private and included in coordinated backups.
- For UI work, follow docs/08-interface-specification.md plus docs/25-admin-order-center.md, docs/26-customer-order-center.md, docs/27-customer-storefront-and-order-placement.md and docs/29-product-cover-images.md. For production work, use the merged T23.0 design in docs/28-production-deployment-design.md and verify the actual target environment under the authorized task scope. A merged PR is not evidence of a deployment or database migration.
