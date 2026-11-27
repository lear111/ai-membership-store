# AI Membership Store

A private, independently operated storefront and order-management system for AI membership services and other digital services.

**Current implementation:** See the [project status index](docs/00-project-status.md) for merged features, remaining work and supporting PRs. The storefront now includes public registration, invitation-based claiming of ADMIN-created customer records (PR #54), 10,000-character dynamic textarea support with bounded UTF-8 payload limits (PR #55), customer and ADMIN self-purchase, own-order and subscription views, WeChat payment claims, the refreshed catalog/detail layout and product covers. Payment verification and fulfillment remain manual. The operating overview remains Mock; order-based renewal, online payment, SMTP notifications, verification-code and API-key APIs remain unimplemented. The earlier ADMIN direct-renewal APIs remain available in compatibility mode.

**Deployment status:** [T23.0 design](docs/28-production-deployment-design.md), [T23.1 application readiness](docs/31-production-clean-install.md) and [T23.2 infrastructure](docs/32-production-infrastructure.md) merged in PR #37, #50 and #51. [T23.3 backup, recovery and monitoring](docs/33-production-backup-and-monitoring.md) merged in PR #52. Production rollout remains separately scoped; T25's 15th migration and T26 application changes are not evidenced as deployed.

**Historical order/subscription foundation:** [Database foundation and compatibility guide](docs/15-order-subscription-foundation.md). Adds structured periods, order snapshots/actors, billing anchors and renewal markers with six additive migrations (fifth through tenth). The review follow-up adds strict source/kind/completeness checks, immutable renewal-cycle snapshots, a separate billing revision and durable per-cycle unique claims. SYSTEM_RENEWAL must be inserted in final PAID/COMPLETED state with paidAt <= paymentConfirmedAt <= fulfilledAt (all non-NULL); updates/deletes remain forbidden. paidAt is actual payment occurrence; PaymentTransaction.createdAt is entry time, and deprecated paymentRecordedAt is retained only for history. The order → full manual payment confirmation → fulfillment → subscription workflow supersedes direct subscriptions for new business. The foundation stage added no APIs or pages; later implementation is tracked in the status index and task reports. Existing Phase 2 APIs remain in compatibility mode. Implementation tests do not deploy to the development database.

Order sources are exclusively USER/ADMIN/SYSTEM_RENEWAL after migration ten. Source is immutable and every order rejects DELETE/REPLACE. OFFLINE_MANUAL and all its CHECK exemptions/special triggers are removed from the final database. Nullable ENUM storage with DEFAULT NULL is intentional: INSERT Trigger plus a non-NULL CHECK reject omitted/NULL sources even under non-strict SQL. The first nine SQL files remain unchanged; migration ten refuses databases still containing retired-source test orders. The foundation report did not inspect or clean development orders/relationships; it does not establish their current state. See the stage guide before any separately authorized migration.

## Operating model: single merchant

This is a **single-merchant storefront**. The site owner is the only merchant and the payment beneficiary. Customers are buyers, not merchants, and do not receive payment-provider sub-merchant accounts. Do not build merchant onboarding, multi-merchant balances, merchant withdrawals, merchant settlement wallets, or marketplace split payments. The payment provider account belongs to the site owner; a future provider integration would record order, payment, refund, and settlement information returned by that provider. Any order-level delayed settlement or refund-from-held-funds capability must be explicitly supported by the selected provider and contract; it cannot be created by changing an order status in this application.

## Business model

The platform is a reseller storefront. It does not initially automate the supplier's membership activation process.

### Target fulfillment workflow

This describes the intended full workflow. The current application records customer orders, manual payment verification and manual fulfillment; supplier/customer email and supplier-transfer integration remain future work. See the [status index](docs/00-project-status.md) before treating a step as implemented.

1. A customer selects a subscription service or a one-time service and submits the required, product-specific information.
2. The customer pays the reseller through an approved payment method.
3. In the MVP, payment is manually verified by an administrator because an automated payment API is not yet available.
4. After payment is verified, the system emails the supplier with the order request and copies the operator when configured.
5. The operator manually transfers the supplier's fixed per-order fee through the agreed channel and records the transfer.
6. The supplier completes the service and sends the invitation or activation instructions to the customer's designated email address.
7. The operator verifies the result and marks the order complete.
8. The system emails the customer to check the designated mailbox for the supplier's invitation or activation message.

The platform must distinguish customer payment, supplier payment, and service fulfillment. They are separate events and must not be represented by one ambiguous status.

## Product types

- **Subscription service:** Has an initial price, a renewal price, a service period, and a membership record with an expiry date. The planned order-based renewal creates a new manually paid order; that flow is not yet implemented and is separate from the retained ADMIN direct-renewal compatibility APIs. Neither performs automatic recurring billing.
- **One-time service:** Has a one-time price and does not create a renewable membership record unless a later product requirement explicitly says otherwise.

## Target MVP scope

This is the product scope, not a completion checklist. Use the [status index](docs/00-project-status.md) for implemented capabilities.

- Public product catalog and product detail pages.
- Customer registration, login, and profile.
- Product-specific order forms using configurable, non-sensitive fields.
- Order creation and customer order history.
- Manual customer-payment verification.
- Supplier request email generated after payment verification.
- Manual recording of supplier transfer and supplier fulfillment.
- Customer completion email.
- Subscription list, renewal price, expiry date, renewal orders, and expiry reminders.
- One unified owner/admin console combining the dashboard, product management, order management, subscription management, user management, and settings. There is no separate merchant portal and administrator portal.
- Audit trail for important administrative actions.

## Explicitly out of scope for the MVP

- Automated card/payment collection until an approved payment product and merchant permissions are available.
- Automated transfer of money to the supplier.
- Supplier API integration. The supplier currently does not have an API; the first version uses email plus manual operations.
- Automatic recurring charges.
- Automatic account login or membership activation on third-party services.
- Automating third-party logins, storing customer credentials in a vault, or emailing authentication secrets on the platform's behalf.
- Multi-supplier routing, affiliate distribution, coupons, wallet balances, and complex accounting.

## Proposed technical baseline

These are implementation defaults, not irreversible decisions. Confirm any change before implementation.

- Frontend: Vue 3, TypeScript, Vite.
- UI: Element Plus; approved visual baseline in docs/08-interface-specification.md.
- Backend: Node.js 24, TypeScript, Express.
- Database: MySQL 8.
- ORM and migrations: Prisma.
- Email, planned: SMTP through a provider account; credentials must be environment variables.
- Development database: Docker Compose. The merged [production design](docs/28-production-deployment-design.md) proposes the existing Caddy, a systemd-managed API and Docker MySQL; server rollout is a separate operation.
- Architecture: modular monolith. Do not introduce microservices or Redis in the MVP without a demonstrated need.

## Documentation reading order

1. AGENTS.md — instructions for Codex and contributors.
2. [docs/00-project-status.md](docs/00-project-status.md) — current implementation, remaining work, merged PRs and deployment evidence.
3. docs/01-product-requirements.md — product scope and requirements.
4. docs/02-user-and-operations-flows.md — customer and operator workflows.
5. docs/03-system-architecture.md — proposed technical architecture.
6. docs/04-data-model.md — domain entities and database design.
7. docs/05-api-contract.md — API contracts and later feature additions.
8. docs/06-security-and-operations.md — security, privacy, and operational rules.
9. docs/07-development-roadmap.md — historical milestones, acceptance criteria and remaining deployment stages.
10. docs/08-interface-specification.md — approved customer and owner/admin responsive UI specification.
11. docs/10-local-operations-mvp.md — local-only customer, offline order, payment record, and subscription management milestone.
12. docs/11-database-foundation.md — Task 1.2.1 schema, local migration/seed instructions, tests and implementation report.
13. docs/12-authentication-customers-invitations.md — Task 1.2.2 implementation, local operation, security boundaries and verification.
14. docs/13-products-settings-forms.md — Task 1.2.3 product/settings persistence, dynamic form contract, migration and isolated verification.
15. docs/14-user-subscription-core.md — Phase 2 user names, frozen subscription forms, direct renewal, concurrency, migration and operation guide.
16. docs/15-order-subscription-foundation.md — order-first model foundation, additive migration, legacy compatibility and deferred service constraints.
17. docs/16-order-read-api.md — administrator/customer order list/detail, safe DTOs, hidden-order/ownership rules and isolated no-Seed API tests.
18. docs/17-order-creation-and-lifecycle-design.md — approved order lifecycle decisions and implementation boundaries.
19. docs/18-order-revision-foundation.md — immutable order revisions, generic idempotency, version/deadline DTOs and isolated tests.
20. docs/19-order-creation-api.md — approved USER/ADMIN order creation endpoints, validation, transaction, idempotency and acceptance contract.
21. docs/20-order-edit-api.md — approved USER/ADMIN order edit endpoints, complete form replacement, price edits, zero-price transition, optimistic concurrency and transaction contract.
22. docs/21-order-cancellation-timeout.md — approved manual cancellation and SYSTEM 24-hour timeout worker contract.
23. docs/22-offline-payment-api.md — approved ADMIN offline payment-attempt registration, verification, failure, concurrency and history contract.
24. docs/23-offline-refund-api.md — approved ADMIN offline full-refund attempt, confirmation, failure, retry and history contract.
25. docs/24-manual-fulfillment-api.md — approved ADMIN fulfillment and initial ORDER subscription creation contract, including frozen timezone/period arithmetic and atomic history.
26. docs/25-admin-order-center.md — approved T20 ADMIN order workspace, safe event timeline, internal-note mutation, and integration contract for T14-T19 operations.
27. docs/26-customer-order-center.md — approved and implemented T21 CUSTOMER own-order list/detail/edit/cancel, order-level refund visibility, lifecycle timeline and offline payment-guidance contract.
28. docs/27-customer-storefront-and-order-placement.md — approved T22 public catalog, protected purchase form, login continuation and offline order-placement design.
29. [docs/28-production-deployment-design.md](docs/28-production-deployment-design.md) — merged production design and historical readiness audit; rollout requires separate evidence.
30. [docs/29-product-cover-images.md](docs/29-product-cover-images.md) — T24.5B single-cover upload, display, storage and migration.
31. [docs/30-storefront-launch-preparation.md](docs/30-storefront-launch-preparation.md) — T23.5-8 customer-facing launch polish, public store branding and isolated acceptance.

32. [docs/31-production-clean-install.md](docs/31-production-clean-install.md) — T23.1 production profiles, first administrator initialization and isolated acceptance.
33. [docs/32-production-infrastructure.md](docs/32-production-infrastructure.md) — T23.2 Caddy, systemd, MySQL and release packaging, with the rehearsal and launch boundaries.
34. [docs/33-production-backup-and-monitoring.md](docs/33-production-backup-and-monitoring.md) — T23.3 paired backups, restore, private logs and monitoring.
35. [docs/34-customer-claim-registration.md](docs/34-customer-claim-registration.md) — T25 merged implementation: label-only customer records and invitation-based registration; production migration/release remain pending.
36. [docs/35-product-form-long-text.md](docs/35-product-form-long-text.md) — T26 merged implementation: 10,000-character textarea and bounded UTF-8 payload limits; no database migration.
37. [docs/36-t27-batch-release.md](docs/36-t27-batch-release.md) — T27 batch release of T25/T26 and one-off Windows backup readiness.

For production, use the [runtime example](.env.production.example), [clean installation guide](docs/31-production-clean-install.md) and [infrastructure runbook](docs/32-production-infrastructure.md). The production API, migrator and first-ADMIN command use separate credential contexts. Provision the clean database and bootstrap the owner before opening public registration in the approved launch window.

Earlier milestone exclusions and test reports describe their original delivery scope. Later merged contracts supersede those exclusions for implemented features; historical test results are not evidence of a new test run or a current deployment.

## Important launch gates

For local T24.1 WeChat collection settings, apply the additive migration before opening the administrator settings page. Set `WECHAT_QR_STORAGE_DIR` to a private absolute path on persistent storage outside the checkout, or use the ignored `.local-data/wechat-qr` directory at the checkout root. Keep the storage directory outside any static web root. Give the API process read/write access and include it in backups with the database. The new switch starts disabled until an administrator uploads an image and enables collection.

Product covers also require the additive migration and a persistent private `PRODUCT_COVER_STORAGE_DIR`. Keep it separate from the WeChat QR directory and outside static web roots, and back up both image directories with the database. See [product-cover storage and recovery](docs/29-product-cover-images.md).

Uploads write an immutable file before the transaction updates the current reference and audit. Superseded files and files left unpublished by failed operations are retained to protect in-flight reads and permit recovery. During maintenance, stop writes, back up both stores and remove only files that are outside the live reference and any retained backup. Keep the storage path stable across API restarts.

Before accepting real orders, the operator must verify that the supplier is authorized to provide and resell the relevant service, that the service provider's terms permit the intended invitation/resale workflow, that customer-facing descriptions are accurate, and that the selected payment/settlement arrangement is permitted for the merchant and product category. The project documents do not constitute legal or payment-provider approval.

## Repository structure

```text
.
├── AGENTS.md
├── README.md
├── package.json             # npm workspaces and common checks
├── frontend/                # Vue 3 / TypeScript / Vite / Element Plus
├── backend/                 # Node.js 24 / Express + Prisma database foundation
├── e2e/                     # desktop and mobile browser checks
├── compose.yaml             # development-only MySQL 8.4
├── .env.example
└── docs/
    ├── 00-project-status.md
    ├── 01-product-requirements.md
    ├── 02-user-and-operations-flows.md
    ├── 03-system-architecture.md
    ├── 04-data-model.md
    ├── 05-api-contract.md
    ├── 06-security-and-operations.md
    ├── 07-development-roadmap.md
    ├── 08-interface-specification.md
    ├── 09-task-1.1-report.md
    ├── 10-local-operations-mvp.md
    ├── 11-database-foundation.md
    ├── 12-authentication-customers-invitations.md
    ├── 13-products-settings-forms.md
    ├── 14-user-subscription-core.md
    ├── 15-order-subscription-foundation.md
    ├── 16-order-read-api.md
    ├── 17-order-creation-and-lifecycle-design.md
    ├── 18-order-revision-foundation.md
    ├── 19-order-creation-api.md
    ├── 20-order-edit-api.md
    ├── 21-order-cancellation-timeout.md
    ├── 22-offline-payment-api.md
    ├── 23-offline-refund-api.md
    ├── 24-manual-fulfillment-api.md
    ├── 25-admin-order-center.md
    ├── 26-customer-order-center.md
    ├── 27-customer-storefront-and-order-placement.md
    ├── 28-production-deployment-design.md
    ├── 29-product-cover-images.md
    └── 30-storefront-launch-preparation.md
```

## Local development

Read the task-specific migration and operation guides for the target version, including the [database foundation](docs/11-database-foundation.md), [authentication](docs/12-authentication-customers-invitations.md), [legacy subscriptions](docs/14-user-subscription-core.md) and [product covers](docs/29-product-cover-images.md). Implementation tests use isolated databases and never migrate the development database.

For an existing initialized database, preserve your `.env` and MySQL volume. After review and an operator backup, apply only committed migrations; do not reset/reseed existing accounts:

```powershell
npm ci
npm run db:status
npm run db:migrate
npm run dev:api
# Another terminal:
npm run dev:web
```

Open `http://localhost:5173/admin/login`; product management is `/admin/products`, settings `/admin/settings`, customers `/admin/users`, subscriptions `/admin/subscriptions`. API defaults to `http://127.0.0.1:3000/api/v1`; APP_BASE_URL must match the frontend origin. Reuse existing correctly configured services instead of starting duplicates. Fresh installations follow the foundation guide for MySQL 8.4/environment/initial seed setup.

The product editor supports integer Fen prices, structured service periods, sorting, listing visibility, irreversible archive, eight-type dynamic forms and a product cover. ADMIN settings include store name, notification email, IANA timezone, plain-text merchant remarks and WeChat collection configuration. The notification email does not change the admin login. Product/settings writes and sanitized audit records share transactions. Unlisted, unarchived products remain available for ADMIN offline orders and eligible legacy subscription operations; archive sets listed=false and prevents further editing or relisting while preserving historical records.

T22.1 opens the catalog and product detail to guests. The public API uses listed, unarchived products and exposes only customer-facing display fields. T22.2 adds a protected purchase form and login continuation. T22.3A requires the purchased product version in the customer creation API. The purchase page validates answers locally, shows a review step, and submits only after explicit confirmation. An unconfirmed response can be retried with the original request and key while the purchase page stays open. T21 customer order history is API-backed; the customer subscriptions page reads the signed-in customer's subscriptions and their visible source orders. The operating overview and remaining prototype demonstrations stay separate from real products, customers, subscriptions, and orders. Mock completion/refund demonstrations move no money and call no business API. Preview values are never saved. The application has no SMTP, payment-provider or upstream-service integration.

## Checks

```powershell
npm run format:check
npm run typecheck
npm run lint
npm run db:validate
npm test
npm run test:db
npm run test:e2e
npm run build
```

Database/E2E tests use random isolated MySQL 8.4 projects/volumes and temporary credentials, never the development `.env` or volume. Upgrade tests first compare every original table through the old compatible migrations, explicitly clean only disposable retired-source order fixtures before final-source deployment, then compare all remaining rows through migration ten; API tests cover strict schemas, authorization, persistence/restarts, audit rollback and unchanged history/accounts. Browser tests use installed Microsoft Edge on desktop and an iPhone-sized viewport against a real isolated API/database, plus explicitly stubbed Mock-history regressions. Viewport emulation is not a physical-device test. Screenshots/traces are ignored under test-results; runners remove only their own resources.

Run customer subscription tests with `npm run test:db -w backend -- --customer-subscriptions-only --fresh` and `npm run test:e2e -w backend -- --customer-subscriptions-only`. Both commands use disposable MySQL and synthetic fixtures without running Seed.

Build artifacts are frontend/dist and backend/dist. Preview can use `npm run preview -w frontend` with the port matching APP_BASE_URL and `npm start -w backend`; these are local previews, not production deployment configuration.

The T14 order read API originally added no frontend history integration; T20 and T21 now provide the ADMIN and CUSTOMER order centers respectively. The order creation POST APIs (PR #11) and core order edit PATCH APIs (PR #14) are merged, specified with verification results in [docs/19-order-creation-api.md](docs/19-order-creation-api.md) and [docs/20-order-edit-api.md](docs/20-order-edit-api.md). Offline payment attempts and full manual confirmation are merged (T17, PR #20); T19 fulfillment is merged (PR #26); customer subscription reads are available at `/subscriptions`. Order-based renewal, notifications and API keys remain unimplemented; the legacy ADMIN direct-renewal API remains available. Use task-specific no-Seed isolated database modes; never target development configuration during implementation tests. Stop at each PR for review.

## Historical delivery and focused checks

These records retain each milestone's scope and verification commands. An exclusion here applies to that delivery only; later merged features and current deployment uncertainty are summarized in the [status index](docs/00-project-status.md).

**Order revision foundation:** [Order versions, append-only history and generic idempotency](docs/18-order-revision-foundation.md). Migration eleven and existing order DTO extensions. The merged [order creation implementation](docs/19-order-creation-api.md) adds customer/admin creation POSTs and migration twelve. T15 reuses those twelve migrations unchanged for the [order edit implementation](docs/20-order-edit-api.md); payment/fulfillment were deferred from T15 and implemented in later stages. Its no-Seed regression command is `npm run test:db -w backend -- --edit-only`, with read regression in a separate random isolated database. Browser regression uses `npm run test:e2e -w backend -- --edit-only` after building.

**T16 cancellation and timeout (merged PR #17):** [Contract and actual validation](docs/21-order-cancellation-timeout.md) implements customer/admin cancellation POSTs and a database-clock SYSTEM minute worker, with versioned atomic history, paid REFUND_PENDING handling and pending-attempt closure. No new migration, refund/payment confirmation API or order UI. Run `npm run test:db -w backend -- --cancellation-only` for no-Seed historical-upgrade/read/cancel/edit/create/revision/subscription regression, and `npm run test:e2e -w backend -- --cancellation-only` after building for fresh isolated browser checks. The worker starts immediately with the API and every minute thereafter; shutdown waits for its in-flight work. Do not start the modified API against development data as an implementation test; deployment requires separate operator review.

**T17 offline payment (merged PR #20):** [docs/22-offline-payment-api.md](docs/22-offline-payment-api.md) implements ADMIN-only attempt listing/registration/confirmation/failure, with exact full-payment verification, multiple-attempt closure, 24-hour deadline and atomic order history. No payment gateway or money movement. Use `npm run test:db -w backend -- --payments-only` for no-Seed isolated historical-upgrade/payment/order/subscription regression and `npm run test:e2e -w backend -- --payments-only` after building for fresh desktop/mobile browser checks. All twelve migrations remain unchanged; development deployment is not included. T17 is merged; do not deploy to the development database without separate authorization.

**T18 offline refunds (merged PR #23):** [docs/23-offline-refund-api.md](docs/23-offline-refund-api.md) implements ADMIN-only full-refund attempts for cancelled REFUND_PENDING orders, exact original payment channel/amount matching, two-stage PENDING/CONFIRMED handling, failed-attempt retry and atomic versioned history. No provider API or money movement. Use `npm run test:db -w backend -- --refunds-only` for no-Seed refund/payment/cancellation/order/subscription regression, historical upgrade, repeat deploy and schema comparison. Browser acceptance uses the existing isolated E2E runner. All twelve migrations are unchanged; no development deployment is included. T18 is merged; T19 implements fulfillment separately below.

**T19 manual fulfillment (merged PR #26):** [docs/24-manual-fulfillment-api.md](docs/24-manual-fulfillment-api.md) defines ADMIN-only fulfillment for INITIAL subscription and ONE_TIME orders, exact PAID/NOT_REQUIRED checks, immutable order snapshot copying, fulfillment-time timezone and structured subscription expiry, and atomic order/subscription/history/audit/idempotency. Delivery failure reuses T16/T18. No renewal or development database deployment. Use `npm run test:db -w backend -- --fulfillment-only` for no-Seed historical-upgrade and T16/T17/T18/order/subscription regression; `npm run test:e2e -w backend -- --fulfillment-only` exercises the endpoint through Edge desktop/mobile cookies and the Vite proxy. The exact new backend runtime dependency is @js-temporal/polyfill 0.5.1; existing dependency versions are unchanged.

**T20 administrator order center (merged PR #29):** `/admin/orders` uses real ADMIN APIs for lists, snapshot details, creation/editing, independent notes, cancellation, offline payment/refund evidence and manual fulfillment. See [docs/25-admin-order-center.md](docs/25-admin-order-center.md). No money is moved by the application. The operating overview remains Mock. T21 customer order center was implemented and merged separately in PR #31. No migration/dependency/development deployment was included. Use `npm run test:db -w backend -- --admin-orders-only` for no-Seed isolated historical-upgrade and T20 HTTP checks; `--fresh` independently verifies a fresh installation. Browser UI acceptance: `npm run test:e2e -w backend -- --admin-orders-only`. Existing startup commands remain `npm run dev:api` and `npm run dev:web` (loopback only); review schema/deployment separately before starting against development data.

**T21 customer order center (merged PR #31):** D98-D105 are implemented in [docs/26-customer-order-center.md](docs/26-customer-order-center.md). `/account/orders` provides the real own-order list/detail/edit/cancel flows and safe offline payment guidance. The existing `/orders` link remains an alias. No online payment, payment evidence, customer refund request, subscription UI or email was added.

**T22 customer storefront and offline order placement:** [docs/27](docs/27-customer-storefront-and-order-placement.md) records D106-D112 and the T22.1 API, pages, and verification. Visitors can browse, search, filter, and page through products. Product detail shows public display fields and a purchase entry. ACTIVE customers can open the protected purchase form, validate their answers locally, and resume after login. T22.3A adds the server-side product version guard. T22.3B connects confirmed submissions to the existing customer order API and opens the resulting order in the customer order center. A changed product requires a fresh review.
