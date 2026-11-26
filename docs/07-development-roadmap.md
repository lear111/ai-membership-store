# Development Roadmap

## How to read this roadmap

Start with the [project status index](00-project-status.md) for the current implemented features, remaining work and merged PRs. This file preserves milestone scope, decisions, acceptance criteria and historical validation results. A completed milestone's exclusions describe that delivery only and do not disable features added later. Recorded test results do not represent a new test run.

The storefront has progressed through the merged T24 additions, including registration, ADMIN self-purchase, customer subscription reads, WeChat payment claims, storefront redesign and product covers. The operating overview remains Mock. Order-based renewal remains future work; the earlier ADMIN direct-renewal API is retained in compatibility mode. Production design is merged, but the currently deployed revision, applied migrations and server state were not inspected for this documentation update.

## Current priority — T27 batch release of T25 and T26

[T23.5-8 storefront launch polish](30-storefront-launch-preparation.md) is merged in PR #53. T25 implementation is merged in [PR #54](https://github.com/lear111/ai-membership-store/pull/54); see [the T25 contract and implementation evidence](34-customer-claim-registration.md).

**T27 is approved for a combined T25 + T26 rollout.** [Release preparation and backup gates](36-t27-batch-release.md) record the reported successful preflight, capacity and Windows SFTP tests. T27.3 one-off backup adaptation is reviewed and merged in [PR #57](https://github.com/lear111/ai-membership-store/pull/57). T27.4 preparation checks are reported complete: the exact historical archive and independently recorded checksum, verified Restic, existing backup network, candidate release artifacts, and Windows restore-directory access are ready. T27.5 combines separately authorized tool installation, temporary credential issuance, maintenance backup and isolated restore/upgrade verification; T27.6 remains a separate production migration and deployment approval. No production migration or deployment until a verified recovery point exists. The normal batch-release policy remains: Continue feature work on `main`, with each change tested in isolated databases and reviewed through PRs. Do not create a production deployment task after every merge. When the owner requests a batch release, inspect the live database and the full migration chain at that time, take one recoverable pre-release backup and verify it through an isolated restore, then apply all pending migrations and deploy the matching compatible application/operations bundle in one controlled window. Because T25 makes `loginEmail` nullable and changes order snapshot constraints, the old `bd9b116` application must not be assumed compatible with the migrated schema; no blind application-only rollback is permitted. A new feature merge or documentation note alone does not authorize production operations.

**T26 product form long text is merged in [PR #55](https://github.com/lear111/ai-membership-store/pull/55).** The implementation raises textarea values/defaults to 10,000 UTF-16 code units, keeps text/email at 500/254, raises serialized schema and `formData` caps to 64 KiB UTF-8, and Express JSON bodies to 128 KiB. Unit, isolated MySQL HTTP, desktop/mobile E2E, typecheck, lint, format, Prisma validation and builds are reported passing. No Prisma migration or dependency change. See [T26 implementation and evidence](35-product-form-long-text.md). Continue accumulating reviewed updates; do not deploy each merge individually.

## Order creation API — merged

**Status: Merged in PR #11 (`b1f5d14`); historical and fresh isolated verification passed. That implementation did not migrate the development database.** [Implementation contract](19-order-creation-api.md).

- Implement POST `/customer/orders` and POST `/admin/orders` only; retain existing GET routes.
- USER self-order requires ACTIVE account and listed/unarchived Product. ADMIN may target ACTIVE/PENDING_ACTIVATION CUSTOMER and listed/unlisted unarchived Product; DISABLED/archived are rejected.
- Both routes validate complete required formData against the Product schema inside the transaction and freeze Product/form snapshots.
- ADMIN must submit final amountFen; the future integrated UI must pre-fill current Product.priceFen. Any deviation requires a reason. USER amount is server-derived.
- Create Order V1, OrderRevision V1, OrderEvent, ADMIN-only audit and generic actorUserId idempotency response atomically.
- Return complete role-safe order resource DTO with HTTP 201. Exact idempotent replay retains the original response; clients may GET detail for a fresh countdown.
- No order edit/cancel/expiry worker/payment/refund/fulfillment/renewal/frontend integration or development DB migration.
- Twelfth incremental migration adds NOT_REQUIRED and compatible zero-price/revision CHECKs; no historical rewrite or development deployment.
- Implementation merged; actual isolated HTTP/MySQL, concurrency/replay/rollback, DTO, browser and regression results are recorded in the implementation report.

## Order edit API — merged

**Status: T15 merged in PR #14 (`5826593`); isolated regression passed. No development database deployment.** [Implementation contract and actual validation](20-order-edit-api.md).

- PATCH `/customer/orders/:id`: owner-only formData complete replacement.
- PATCH `/admin/orders/:id`: formData complete replacement and optional amountFen change in one atomic edit.
- Both require expectedVersion + Idempotency-Key; stale concurrent edits return 409.
- Use frozen formSchemaSnapshot, append exactly one OrderRevision per successful edit, one OrderEvent and ADMIN-only audit.
- internalNote remains a separate D48 endpoint; it still increments Order.version and appends Revision/Event/AdminAuditLog atomically, but is outside T15.
- If ADMIN changes an eligible UNPAID order amountFen to 0, the same transaction changes it to NOT_REQUIRED + PROCESSING (D64); paid orders cannot be converted this way.
- Implementation merged; no development database deployment.

T15 reuses all twelve committed migrations unchanged. Actual amount changes require a reason; supplied reasons without a price change are rejected, as are effective no-ops. Database-time eligibility is checked after the row lock and again in the conditional UPDATE. Fault-injection, real concurrent HTTP, exact DTO/replay and desktop/mobile browser coverage accompany the implementation. The read regression suite runs in its own isolated database to retain its complete-dataset assertions without deleting protected order history. No internal-note, cancel, timeout, payment, fulfillment or frontend order-management feature is included.

## Order cancellation and timeout — merged

**Status: T16 merged in PR #17 (`56b0ba40`); ADMIN pending-verification correction included; final isolated regression passed. No development database deployment.** [Implementation contract and validation](21-order-cancellation-timeout.md).

- POST `/customer/orders/:id/cancel`: owner-only cancellation of eligible unpaid order; reason optional.
- POST `/admin/orders/:id/cancel`: ADMIN cancellation of eligible unpaid, paid-before-fulfillment or zero-price order; reason mandatory.
- Both require expectedVersion and Idempotency-Key; cancellation is terminal and versioned.
- Paid cancellation enters CANCELLED + REFUND_PENDING; confirmed payment transaction is retained. Refund completion is separate and not included.
- Zero-price cancellation follows D53; no refund.
- SYSTEM timeout worker runs every minute using DB UTC time; cancels expired UNPAID/PENDING_VERIFICATION ordinary orders, closes pending payment attempts as FAILED, and writes SYSTEM Revision/Event without AdminAuditLog.
- Payment confirmation, refund, fulfillment, notifications and frontend remain out of scope. Stop at PR review; no development DB deployment.

Reuses all twelve migrations unchanged. Both manual handlers share the locked atomic cancellation service, with normalized original-response idempotency and exact role-safe DTOs. The worker processes at most 100 deterministic candidates per minute, with per-order SKIP LOCKED transactions, SYSTEM NULL actors, per-row rollback/retry and graceful shutdown. Real HTTP/MySQL tests cover payment facts, pending-attempt closure, all-stage fault injection, manual/worker/payment-lock races, repeated scans and existing write/read/subscription regressions. T16 payment-race tests used a synthetic writer; the payment-confirmation API was implemented separately in T17.

## T17 offline payment attempts and confirmation — merged

**Status: Merged in PR #20; implementation and isolated validation recorded in [T17 report](22-offline-payment-api.md). No development deployment.** [Implementation contract and actual results](22-offline-payment-api.md).

- ADMIN-only GET payment attempts; POST register PENDING; POST confirm full payment; POST mark one attempt FAILED.
- Registration is separate from confirmation. Amount mismatch may be recorded as PENDING but must fail verification; never rewrite actual amount.
- Confirmation requires exact amount, no other PENDING attempts, no confirmed payment facts and DB time strictly before original 24-hour deadline.
- Failure requires a reason, preserves original payment evidence and recomputes order summary based on remaining PENDING/confirmed attempts.
- Every successful register/confirm/fail operation increments Order.version once and writes Revision/Event/AdminAuditLog/idempotency atomically.
- Payment routes lock Order before PaymentTransaction, matching T16 timeout/cancellation. No payment gateway, refunds, fulfillment, subscriptions or frontend UI.
- Reuses all twelve migrations unchanged; stop at PR review and do not deploy to development DB. Use `npm run test:db -w backend -- --payments-only` for historical-upgrade and existing order/subscription regression, and `npm run test:e2e -w backend -- --payments-only` after building for fresh desktop/mobile browser checks. No Seed or development configuration is used.

## T18 offline refund management — merged

**Status: Merged in PR #23 (`e9cb429f`); 135/135 isolated HTTP regression and 22/22 focused desktop/mobile browser regression passed. No development database deployment.** [Full implementation contract and validation](23-offline-refund-api.md).

- ADMIN-only GET refund attempts; POST register externally initiated full refund as PENDING; POST confirm after verifying actual return; POST fail with mandatory reason.
- Only CANCELLED + REFUND_PENDING orders with exactly one confirmed full PAYMENT are eligible. No refunds for completed fulfillment or zero-price orders.
- Refund amount and channel must exactly match the original confirmed PAYMENT.
- At most one PENDING REFUND and one CONFIRMED full REFUND per order. FAILED attempts remain in history and may be retried with a new attempt.
- PENDING does not mean money returned. Confirmation changes paymentStatus to REFUNDED while fulfillmentStatus remains CANCELLED.
- Every successful mutation increments Order.version once and writes Revision/Event/AdminAuditLog/idempotency atomically. Lock order remains Order -> PaymentTransaction, matching T16/T17.
- No partial refunds, provider APIs, money movement, fulfillment or subscription work. All twelve migrations unchanged; stop at PR review and do not deploy to development DB. Use `npm run test:db -w backend -- --refunds-only` for isolated HTTP refund and existing regression; browser checks use the same no-Seed runner.

## T19 manual fulfillment and initial subscription entitlement — merged

**Status: Merged in PR #26 (`b64d608a`); 156/156 isolated MySQL regression, 8/8 desktop/mobile E2E and all unit/type/lint/format/build/Schema checks passed. No development database deployment.** [Implementation contract and actual verification](24-manual-fulfillment-api.md).

- ADMIN-only POST `/admin/orders/:id/fulfill`; supports ordinary USER/ADMIN INITIAL subscription and ONE_TIME orders only. RENEWAL and SYSTEM_RENEWAL are excluded.
- Eligible paid orders require PAID + PROCESSING and exactly one matching confirmed full PAYMENT. Zero-price orders require NOT_REQUIRED + PROCESSING, amount=0, NULL payment times and no transaction rows.
- ONE_TIME completes without Subscription. INITIAL creates one unique sourceType=ORDER Subscription, copying every frozen Order product/period/form snapshot; no merging or extension of existing subscriptions.
- startedAt, billingAnchorAt and currentPeriodStartAt equal the same DB UTC fulfilledAt. AppSettings.timezone is read and frozen at fulfillment. DAY is fixed 24-hour duration; MONTH/YEAR use timezone-aware calendar arithmetic with original day anchor, month-end clamp and defined DST behavior.
- One transaction commits Order COMPLETED/version/Revision/Event, optional Subscription + CREATED SubscriptionEvent, separate Order and Subscription AdminAuditLog rows, and idempotency response. Any failure rolls back all writes.
- No fulfillment FAILED state; undeliverable orders reuse T16 cancellation and T18 refund. No renewal, system renewal, subscription expiry worker, supplier API, customer subscription UI or notifications.
- No migration expected. Stop at PR review; no development database deployment.

## T20 administrator order center — merged in PR #29

**Status: D89-D97 implemented and merged in PR #29 (squash commit `6b1a30d3`).** [Contract and actual validation report](25-admin-order-center.md). No development database deployment.

- Replace only the ADMIN `/admin/orders` Mock page with a real API-driven order workspace; keep the CUSTOMER order page and operating overview unchanged.
- Reuse T14-T19 create/edit/cancel/payment/refund/fulfillment APIs. Add only ADMIN OrderEvent timeline GET, minimal linkedSubscription detail summary, frozen productType list filter, and D48 internal-note PATCH.
- The list uses separate payment/fulfillment states; `fulfillmentStatus=PROCESSING` includes PAID and NOT_REQUIRED zero-price orders.
- The detail includes safe order/customer/form snapshots, payment/refund evidence, linked subscription summary, internal note and a safe OrderEvent timeline. Never expose raw event JSON, AdminAuditLog or OrderRevision; D41 remains active.
- Internal-note update is ADMIN-only, allowed for visible USER/ADMIN orders including terminal states, requires expectedVersion and Idempotency-Key, increments version once, and writes complete Revision/Event/Audit/idempotency atomically. SYSTEM_RENEWAL remains immutable.
- Refund is only available after cancellation to REFUND_PENDING; fulfillment reuses T19. Unsupported renewal/system/legacy states are read-only.
- Add desktop/mobile E2E for create → payment → fulfillment and cancel → refund, plus note/version/idempotency and safe timeline tests.
- No Prisma Schema/Migration or new dependency was added. CUSTOMER order UI, overview, online payment, supplier, email, renewal and deployment remained outside T20.

## T21 customer order center — merged in PR #31

**Status: D98-D105 implemented and merged in PR #31 (squash commit d166c53).** [Full implementation contract and verification](26-customer-order-center.md). No development database deployment.

- Replace only the CUSTOMER /account/orders Mock page with real own-order list/detail/edit/cancel flows, reusing the existing customer APIs. Require an ACTIVE CUSTOMER Session and preserve hidden/ownership 404 behavior.
- Display frozen product/form snapshots, separate payment/fulfillment states, server pagination/search, and the original 24-hour countdown. NOT_REQUIRED + PROCESSING zero-price orders appear as 处理中.
- Customer can edit only eligible UNPAID + NOT_STARTED formData using the frozen schema; customer can cancel own UNPAID/PENDING_VERIFICATION orders only when no confirmed payment fact exists. PENDING_VERIFICATION cancellation requires a clear warning.
- Refund visibility is order-level only. REFUND_PENDING is labeled 待退款 (it does not prove the external transfer has started); REFUNDED is shown only after ADMIN confirms actual external refund completion.
- Timeline uses createdAt/paidAt/paymentConfirmedAt/fulfilledAt/cancelledAt only; no CUSTOMER OrderEvent, Revision, Audit or payment/refund attempt read.
- The existing AppSettings.paymentInstructions plain-text field and CUSTOMER GET /customer/order-guidance provide eligible offline payment instructions. No migration was added.
- T21 includes no online payment, proof upload, refund request, checkout/order creation, subscription UI or email. Its final review follow-up covers response-anchored countdowns and empty-form edit visibility.

## T22 customer storefront and offline order placement

**Status: D106-D112 approved in PR #32. T22 implementation merged.** [Design and implementation records](27-customer-storefront-and-order-placement.md).

- T22.1 public catalog API and catalog/detail views are merged in PR #33.
- T22.2 protected purchase form, login continuation, and client-side checks are merged in PR #34.
- T22.3A customer creation version guard and safe CUSTOMER order DTOs are merged in PR #35.
- T22.3B storefront order submission, idempotent retry and order-center continuation are merged in PR #36. Public deployment readiness is tracked separately in T23.

- Public GET catalog list/detail exposes only listed, unarchived product display fields. Public DTOs never expose formSchema, defaults, administrator fields, or archive/listing internals.
- Product detail does not load or display dynamic form fields. T22.2 enables 立即购买 and lets an ACTIVE CUSTOMER enter /purchase/:slug to fetch the customer-safe form projection.
- Guests are redirected to login with a validated same-origin purchase destination; successful login returns to the same purchase route and loads the form. T22 originally admitted CUSTOMER only; merged T24.4B.1 extends the same own-account flow to ACTIVE ADMIN sessions.
- Reuse the existing eight-type form contract and ProductFormInputs. Do not apply administrator defaultValue values or persist incomplete drafts.
- T22.3A extends POST /customer/orders. Customer price remains server-derived; product/form snapshots, complete validation, zero-price behavior, atomic history and Idempotency-Key remain unchanged.
- The CUSTOMER API requires expectedProductUpdatedAt. It replays matching committed requests before checking the current version. Under the Product row lock a stale version returns 409 PRODUCT_CHANGED with no writes. T22.3B reloads the product, discards the old draft, and requires explicit review for the fresh version.
- A successful storefront submission or idempotent replay opens the existing T21 order detail using /account/orders?orderId=:id. T21 originally supplied plain-text payment guidance; merged T24.2 adds the protected WeChat QR and payment-claim panel.
- No cart, online payment, proof upload, customer subscription/renewal, email, supplier automation, migration, deployment, or runtime dependency is included.

## T23 — Production deployment readiness

**Status** — T23.0 design, T23.1 application readiness and T23.2 infrastructure merged in PR #37, #50 and #51. T23.3 backup and monitoring merged in PR #52. The [Seoul readiness audit](28-production-deployment-design.md) is historical. See the [status index](00-project-status.md) for the current repository snapshot.

- T23.1 — Production configuration and first ADMIN. The [Clean Install guide](31-production-clean-install.md) covers the HTTPS profile, separate database accounts, proxy trust, explicit migration and bootstrap, and service drain.
- T23.2 — Caddy, systemd and MySQL deployment definitions. The [infrastructure guide](32-production-infrastructure.md) records the templates, Linux release build, checksum/installation and rollback tooling, and candidate ports.
- T23.3 — [Backup, recovery, logging and monitoring](33-production-backup-and-monitoring.md). Validate encrypted backup and isolated restore, log redaction and alerts. The suggested RPO of six hours and RTO of four hours are rehearsal objectives.
- T23.4 — Isolated deployment rehearsal and launch checklist. Verify shared-host capacity, prior-site health, application behavior and recovery before requesting T23.5 approval.
- T23.5 — Controlled production launch. Under separate approvals, verify the recovery point, apply the approved Migration, configure DNS and firewall, start the dedicated services and reload Caddy. Verify smoke tests and existing-site health before opening traffic, with a rehearsed rollback ready.

Each stage requires its own review. Production Migration, data cleanup, service restarts and deployment require separate approval for the specific operation. T23.0 approves no production installation or application changes.

## T24 — Storefront and offline collection additions

**Status: The additions through PR #46 are merged.** The [status index](00-project-status.md) maintains the PR-to-feature mapping and current boundaries, rather than duplicating that list here.

Merged behavior includes readable order numbers, private WeChat QR configuration and customer payment claims, own-subscription reads, ADMIN self-purchase, public customer registration, storefront layout updates and optional product covers. A payment claim requests manual verification and does not establish a confirmed receipt. Product-cover changes preserve the existing product-version protection at checkout.

Contracts are recorded in [API contracts](05-api-contract.md), [UI specification](08-interface-specification.md), [customer order center](26-customer-order-center.md) and [product-cover implementation](29-product-cover-images.md). These additions supersede earlier milestone exclusions for the corresponding features without introducing online payment, SMTP or automatic fulfillment.

## Order revision / generic idempotency foundation

**Status: Merged in PR #9; development database migration remains a separately authorized operation.** [Schema, immutable history and test guide](18-order-revision-foundation.md).

- Eleventh incremental migration: Order.version, strict V1 append-only OrderRevision, in-place actorUserId idempotency rename. Ten historical migration files unchanged.
- Existing order GET DTOs add version and server-derived deadline/countdown; ADMIN additionally receives internalNote, CUSTOMER excludes it.
- New isolated historical/fresh tests and existing subscription idempotency/read API regressions; no order write API or frontend change.
- Order creation has since been implemented in PR #11; the next lifecycle stage requires separate authorization.

## Order API stage 1 — lists and details

**Status: Merged; the original read-only stage followed model PR #6.** [Contract and isolated verification](16-order-read-api.md).

- ADMIN and Session-authenticated CUSTOMER order list/detail GETs only; hidden=false in every database predicate, CUSTOMER ownership derived only from Session.
- Strict pagination/search/kind/payment/fulfillment/sort filters; explicit per-role snapshot DTOs without authentication/audit data (subsequent foundation adds ADMIN-only internalNote) or current-Product substitutions.
- Random isolated MySQL8.4 HTTP tests, including all-table preservation after reads; orders-only runner executes no Seed and never uses development configuration.
- No order creation/edit/cancellation/payment/fulfillment/renewal, frontend page, database migration or development data change. Stop for acceptance; no automatic next stage.

## T13 — Product structured service periods

**Status: Product periods merged in PR #8 (`c426ae0`); order creation is merged as described above.** See [T13 contract and isolated verification](17-order-creation-and-lifecycle-design.md#g-商品周期能力缺口创建订单前置任务).

- Product ADMIN API/DTO/editor expose DAY/MONTH/YEAR and positive integer count; termLabel remains descriptive.
- New subscriptions require complete periods. ONE_TIME stores NULL periods and renewal price. Type changes validate the merged record.
- Legacy NULL/NULL subscriptions can save unrelated edits without inference. Explicit period edits require both valid fields; future order creation must reject unknown periods.
- No Schema/Migration/dependency changes. Unit, real HTTP isolated MySQL and desktop/mobile browser regression use the no-Seed `--products-only` runner.

## Order/subscription refactoring — Stage 1 database foundation

**Status: Merged in PR #6. Historical scope: schema, migrations, compatibility and tests only.** See [stage guide](15-order-subscription-foundation.md).

- Structured DAY/MONTH/YEAR periods and quantities; retain termLabel and unknown legacy NULLs.
- Order product/period/form/data snapshots; USER/ADMIN/SYSTEM_RENEWAL origins, hidden renewals, lifecycle times and USER/ADMIN/SYSTEM events.
- ORDER subscription source requiring a unique source order, frozen billing period/anchor/timezone, current cycle and early-renewal marker. Retain legacy unlinked ADMIN/SYSTEM records.
- Site-wide plain-text paymentInstructions; preserve PaymentTransaction and all old states/records.
- Fifth foundation, sixth review-integrity, seventh actual-payment-time, eighth explicit-source-guard, ninth immutable-source/history-protection and tenth final-source migrations; verify all twelve populated legacy business tables, repeated deploy and fresh installation in isolated MySQL 8.4 only.
- Review follow-up: strict source/kind/visibility, complete ORDER subscriptions, validated timezone, independent billingRevision/explicit renewal eligibility, immutable renewal target/anchor/revision snapshots, two durable unique cycle claims and paid-renewal update/delete guards.
- P1 final-state and payment-time repair: SYSTEM_RENEWAL INSERT requires PAID/COMPLETED and non-NULL paidAt <= paymentConfirmedAt <= fulfilledAt with no cancellation; keep immutable triggers. paidAt is actual payment, matching the confirmed PAYMENT's occurredAt in the future transaction; PaymentTransaction.createdAt is entry time. Retain deprecated paymentRecordedAt unchanged and unused by new flows. Verify populated upgrades and fresh installs with --models-only (no Seed), including rejected intermediate states, distinct occurrence/entry/confirmation times and complete transaction rollback.
- Verification includes populated upgrades through the tenth migration after explicit disposable test-order cleanup and fresh ten-migration installation, SQL rejection/immutability/concurrent uniqueness/transaction rollback fixtures. No historical actual payment time is inferred or backfilled.
- Final-source model: only USER/ADMIN/SYSTEM_RENEWAL; retire the old source and every exemption/special trigger. Keep permanent source identity, all-order DELETE/REPLACE protection and the original renewal guards. Nullable ENUM storage plus a required-source Trigger/CHECK rejects missing/NULL/invalid sources under strict and non-strict SQL.
- Preserve the first nine migration files, including the first four published on main. Migration ten fails fast while retired-source orders exist. Verify old migration compatibility before explicit isolated-fixture cleanup, then compare all twelve business tables through the final upgrade; never inspect or clean development data in this task.
- No new page, order/payment API, calendar algorithm, automatic fulfillment or renewal worker. Do not begin the next service stage without approval.

The new business target is order → confirmed full offline payment → fulfillment → order-linked subscription. Older direct-subscription descriptions below document the Phase 2 compatibility runtime, not the future workflow.

## Phase 2 — User Model Refactoring & Subscription Management Core

**Status: Merged; retained as compatibility runtime alongside the later order-based initial-purchase workflow.** [Design, migration, tests and operation guide](14-user-subscription-core.md).

This separately authorized phase delivered user names/privacy, additive migration with SUSPENDED preflight, immutable subscription snapshots/eight-type form data, ADMIN list/create/detail/edit/renew/terminate/history, optimistic versions, persistent idempotency and minute expiry termination. It preserved accounts/sessions/invitations/history and used only isolated databases for implementation tests. Its direct renewal updates an eligible subscription with an explicitly supplied expiry and creates no order or payment; it does not implement the planned order-based renewal. Order/payment, notification, verification-code, API-key and upstream work were outside this phase. Target-database migration remains an operator-controlled step.

## Delivery rules

- Implement one task at a time.
- Do not skip acceptance criteria.
- Do not implement online payment, supplier API, SMTP, or deployment during the local offline operations milestone.
- Keep docs synchronized with implementation.
- Owner reviews each milestone/PR before the next substantial task.

## Architecture decision — single merchant

**Status: Confirmed by owner**

- [x] One site owner is the only merchant.
- [x] Customers are buyers only; no customer sub-merchant accounts.
- [x] No multi-merchant onboarding, merchant wallets, merchant balances, merchant withdrawals, or split settlement.
- [x] Payment provider account and settlement relationship belong to the site owner.
- [x] Provider-level delayed settlement/held funds are optional external capabilities, never simulated by application order status.

## Phase 0 — Planning baseline

**Status: Complete**

- [x] Record business model and manual fulfillment workflow.
- [x] Define customer pages and one unified owner/admin console.
- [x] Define subscription versus one-time product behavior.
- [x] Define proposed stack and modular-monolith architecture.
- [x] Define initial domain model and API contract.
- [x] Define security boundaries and launch gates.
- [x] Create roadmap and Codex instructions.

## Phase 1 — Repository scaffold and local operations

**Historical phase plan:** Tasks 1.1–1.2.3 are merged. The original Task 1.2.4 work was delivered through the later order/payment/refund/fulfillment stages. The customer portal has also progressed; the overview remains Mock. Use the status index rather than these original task boundaries for current availability.

### Task 1.1 — Responsive Mock UI prototype

**Status: Complete.** See [Task 1.1 implementation report](09-task-1.1-report.md).

- Vue 3 + TypeScript + Vite frontend.
- Node.js 24 + TypeScript + Express health API.
- MySQL 8.4 Docker Compose development service.
- Customer storefront and unified owner/admin console with Mock data.
- Responsive desktop/mobile layouts and local interactions.
- No business database, authentication, payment, email, or supplier integration.

### Task 1.2 — Local offline customer and order management

**Historical milestone:** Foundation, authentication/customers/invitations and product/settings persistence are merged. Subsequent milestones separately implemented orders, storefront purchases and customer self-service.

Read [10-local-operations-mvp.md](10-local-operations-mvp.md) for this milestone's original scope. Later changes are summarized in the [status index](00-project-status.md), with current contracts in [04-data-model.md](04-data-model.md) and [05-api-contract.md](05-api-contract.md).

The milestone originally targeted a local application for existing customers who pay offline. That historical scope does not describe the current storefront or establish any server deployment status.

#### Task 1.2.1 — Prisma and local database foundation

**Status: Complete, reviewed before Task 1.2.2 was authorized.** Historical schema/verification report: [11-database-foundation.md](11-database-foundation.md).

- Add Prisma and a MySQL datasource.
- Implement all 11 models in docs/04-data-model.md.
- Add an initial migration and migration scripts.
- Add environment validation for DATABASE_URL, APP_BASE_URL, ADMIN_EMAIL, and ADMIN_PASSWORD.
- Add database readiness to the health endpoint.
- Add an idempotent seed for exactly one ADMIN account. Do not overwrite an existing admin password on each seed run.
- Keep services bound to loopback for local use.
- Do not implement business CRUD, customer activation UI, online checkout, email, or payment/supplier integrations in this subtask.

Acceptance:
- Migration succeeds against a clean MySQL 8.4 volume.
- Re-running migration/seed is safe.
- Seed creates one ADMIN with a hashed password from local env configuration.
- Database health is reported accurately; API health does not claim DB-ready when DB is unavailable.
- Environment errors fail clearly without printing secrets.
- Format, typecheck, lint, tests, build pass.
- Stop and wait for owner review.

#### Task 1.2.2 — Authentication, customers, and invitations

**Status: Merged and separately followed by owner-authorized Task 1.2.3.** Historical report: [12-authentication-customers-invitations.md](12-authentication-customers-invitations.md).

- Implement admin login/logout/me with server-side sessions.
- Implement admin customer creation/edit/disable.
- Create customers as PENDING_ACTIVATION with nullable passwordHash.
- Generate/reissue/revoke one-time invitation links; store only token hashes.
- Add customer activation page and login.
- Allow subscriptions/orders to reference pending customers.
- No email sending of any kind.

Acceptance:
- Admin APIs reject unauthenticated/non-admin requests.
- Invitation is one-time, expires after 7 days, and reissue revokes prior unused token.
- Admin can copy the raw invitation URL once.
- Pending customer can own order/subscription records.
- No email is sent.
- Localhost-link reachability limitation is shown.

#### Task 1.2.3 — Product and settings persistence

**Status: Merged.** See [13-products-settings-forms.md](13-products-settings-forms.md) for the original delivery and later product additions.

- Replace product Mock state with database-backed CRUD.
- Persist only listed (catalog visibility) and archivedAt (irreversible archive) as product state. Unlisted/unarchived products remain ADMIN-selectable for future offline operations.
- Add archive instead of hard delete; atomically set listed=false, prohibit edits/relisting, preserve historical orders and existing entitlements.
- Persist storeName, ownerEmail, and timezone.
- Configure/preview eight dynamic field types with stable IDs, server validation and safe JSON defaults.
- Keep the committed additive form migration and add a versioned follow-up removing obsolete permission columns and unlisting archived rows; preserve all eleven business tables, saved forms and remaining data.
- Verify real admin product/settings UI at desktop and mobile sizes using isolated MySQL fixtures.

Acceptance:
- Product edits survive refresh/restart.
- Listing/archive semantics match docs/08-interface-specification.md; no separate purchase or renewal controls remain.
- Historical snapshots remain unchanged after product edits.
- No supplier cost fields.

Future order selection must allow unlisted/unarchived products and reject archived products. Phase 2 now implements independent ADMIN subscriptions for unlisted/unarchived SUBSCRIPTION products and rejects archived or ONE_TIME products. Task 1.2.3 itself added no subscription writes.

#### Task 1.2.4 — Offline orders, payments, refunds, and fulfillment

**Historical placeholder, superseded by the merged order lifecycle stages above.** T19 allows PAID and NOT_REQUIRED zero-price fulfillment; the original paid-only acceptance line below is historical. A SYSTEM_RENEWAL database model does not mean a renewal service is implemented.

- Admin creates ADMIN INITIAL/ONE_TIME orders. SYSTEM_RENEWAL creates only final paid/completed hidden RENEWAL orders; ordinary admin/customer renewal handling is a future service task.
- Record payment channel, amount, actual time, reference, and note.
- Admin confirms actual offline payment after checking the external account.
- Record full refunds as pending/confirmed/failed after private customer discussion; application never sends money.
- Admin updates fulfillment status with a reason.
- Add order events and audit logs.

Acceptance:
- Payment and fulfillment states are independent.
- Unpaid/unverified orders are not counted as paid or awaiting fulfillment.
- Payment summary reconciles with transaction records.
- Only paid orders can complete.
- Refund is marked successful only after external refund is actually sent.
- Refund and fulfillment transitions are atomic and audited.

#### Task 1.2.5 — Superseded subscription sequence

The merged Phase 2 above replaced this earlier sequence and remains available for legacy ADMIN subscription management. Later stages added order-linked initial entitlements. Do not start a duplicate Phase 2 task or restore the former suspension/resumption states.

- ADMIN creates independent subscriptions for active or pending customers, with frozen product/form snapshots.
- Direct renewal changes the existing unexpired subscription using an explicit expiry, without orders/payments or guessed durations.
- Version checks, persistent idempotency, event/audit history and automatic expiry termination protect state changes.
- ADMIN/SYSTEM sources and ACTIVE/TERMINATED states describe the Phase 2 direct-management compatibility contract; later order fulfillment also creates ORDER subscriptions. Preserve old event rows and legacy source-order references.
- Development migration still requires separate operator authorization after PR review. See [Phase 2 operation and verification guide](14-user-subscription-core.md).

#### Task 1.2.6 — Dashboard and customer read-only portal

**Historical combined plan:** The own-order and subscription views are implemented in later milestones, and T22 opened storefront purchasing. The dashboard portion remains future work; the checkout-disabled line below no longer describes the current application.

- Replace overview Mock metrics with database-backed metrics.
- Customer can activate/login and view only their own orders/subscriptions.
- Keep online catalog purchase/checkout disabled.
- Add E2E tests for complete local offline workflows.
- Document local start, backup, and reset procedures.

Acceptance:
- Dashboard reconciles with confirmed transaction records.
- Customer cannot access another user's data or admin APIs.
- Data survives refresh and service/container restart.
- No online payment, supplier, or email calls occur.
- All checks pass and owner reviews the milestone.

## Future phases — not authorized by Task 1.2

The following were excluded from the original Task 1.2 scope. Later milestones implemented storefront checkout and self-service; remaining capabilities are tracked in the status index. This historical list neither revokes later authorization nor authorizes deployment:

- Public online checkout and payment provider integration.
- Supplier email/API and automated fulfillment.
- SMTP notifications and expiry reminders.
- Production deployment, public access, and external customer invitation links.
- Advanced accounting, supplier costs, or multi-merchant features.

## Current review boundary

Use the [project status index](00-project-status.md) for current merged work and remaining tasks. PR #37's deployment design and subsequent storefront changes through PR #46 are merged. Future implementation work and operational changes still require their applicable task scope and review; this documentation update does not authorize a new feature or a server change.

T19 supersedes the original Task 1.2.4 fulfillment placeholder: use the merged D24-D32/D37/D52/D59/D64/D83-D88 contract in [manual-fulfillment contract](24-manual-fulfillment-api.md). In particular, NOT_REQUIRED zero-price orders are fulfillable, and renewal/SYSTEM_RENEWAL are excluded from that fulfillment service.


## T19 — Manual fulfillment and first ORDER entitlement

- [x] ADMIN-only POST `/api/v1/admin/orders/:id/fulfill`, strict version/key/note and safe DTOs.
- [x] INITIAL/ONE_TIME, exact PAID/NOT_REQUIRED eligibility and retained receipt evidence.
- [x] Unique ORDER Subscription from frozen Order snapshots; locked fulfillment-time settings and D86 arithmetic.
- [x] Atomic Order/version/Revision/Event, optional Subscription/Event, one/two audits and original idempotency response.
- [x] Isolated HTTP/SQL-fault/calendar/concurrency tests and desktop/mobile browser acceptance added.
- [x] Implementation PR reviewed and merged in PR #26.

Deployment is a separately authorized operational action; current server state is not established by this historical checklist.

No Migration, development database operation, renewal, provider integration, email or frontend page. Actual validation is recorded in docs/24.


T20 supersedes only the ADMIN order-page Mock boundary in the original Task 1.2.3 UI prototype. T21 supersedes the CUSTOMER `/account/orders` Mock boundary for existing-order management. The operating overview remains Mock. See [T20](25-admin-order-center.md) and [T21](26-customer-order-center.md).

T22.1 adds guest-accessible product browsing and detail using the public catalog API. The [T22 design](27-customer-storefront-and-order-placement.md) records the T22.2 purchase form, the T22.3A API guard and the T22.3B storefront order submission.
