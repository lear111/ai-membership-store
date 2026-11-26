# Current Project Status

**Verified implementation snapshot** — `main` at [`7eadad7af03c96799bfdefba715d443212a08b05`](https://github.com/lear111/ai-membership-store/commit/7eadad7af03c96799bfdefba715d443212a08b05), the merge of [PR #57](https://github.com/lear111/ai-membership-store/pull/57) (T27.3 one-off Windows backup/restore tooling). The application baseline remains [PR #55](https://github.com/lear111/ai-membership-store/pull/55) at `408b3b276a26abe97be2b519f5d8d9f19fc68682`, following T25 in PR #54. Subsequent documentation-only commits do not alter this implementation baseline.

This index records implemented repository capabilities and outstanding boundaries. It is not a release record, a new test run, or evidence that a server or database has been upgraded. Check the current branch and relevant PR before starting another task.

## How to read the documentation

- Use this index and the [development roadmap](07-development-roadmap.md) for implementation status. Use the linked task contracts and [API contract](05-api-contract.md) for behavior, permissions and validation.
- Earlier milestone reports retain their original scope and test results. Statements such as “no order API in this stage” describe that stage; they do not remove capabilities merged later.
- The [contributor instructions](../AGENTS.md) retain the security, privacy, data-preservation and task-scope rules. An unresolved business-rule conflict still requires a decision; this status reconciliation changes no product rules.
- Product requirements and architecture describe some future capabilities. In particular, planned email, supplier and payment-provider flows are not evidence that those integrations exist.

The current main includes the customer order detail and product description links, T23.1 production application profile and T23.2 infrastructure. [T23.3 backup and monitoring](33-production-backup-and-monitoring.md) is also merged.

## Current work priority

[T23.5-8 storefront launch polish](30-storefront-launch-preparation.md) is merged in PR #53. The public name API, shared branding and demonstration label are implemented.

**T25 customer records and invitation registration is implemented and merged in PR #54.** ADMIN creates a label-only customer record; the customer uses the existing invitation link to register with their own email/password and claim the same User ID. Migration 15 makes `loginEmail` nullable, preserves the unique index, clears only confirmed never-activated ADMIN-created customer emails, and allows nullable order contact snapshots without rewriting history. See [T25 contract and implementation evidence](34-customer-claim-registration.md).

**T27 batch release is approved, migration and deployment are gated on recovery readiness.** See [T27 release preparation](36-t27-batch-release.md): reported live preflight and Windows SFTP tunnel tests passed, T27.3 backup tooling is merged, T27.4 preparation checks (including the production SSH/network checks and Windows restore-directory access) are reported complete. T27.5 was attempted but failed at Windows SFTP repository initialization, leaving no valid recovery point. The operator reports the site remains gated in maintenance with the original application/schema unchanged. Restore the original service only under owner authorization and resolve the actual receiver compatibility with synthetic data before a new backup window. Do not infer production readiness from the reported synthetic tests. The following policy continues to apply to subsequent feature merges.

**Batch release policy.** The owner has chosen to accumulate several application updates and deploy them together rather than migrate production for each individual PR. The last production release evidence provided in this conversation is T23.5-9 at `bd9b116`; no evidence here shows migration 15, PR #54, or the T26 application changes deployed. Continue development and isolated validation against `main`. When the owner chooses a release window, inspect the actual production account classification, create and verify a recoverable backup/restore point, then apply the complete reviewed migration chain and deploy one compatible release. Do not perform production preflight, backup, migration, or deployment merely because another PR merges.

**T26 product form long text is implemented and merged in PR #55.** Each dynamic `textarea` input/default supports 10,000 UTF-16 code units; `text` remains 500 and `email` 254. Serialized schema and order `formData` each allow 64 KiB UTF-8; Express JSON bodies allow 128 KiB. No Prisma Schema/Migration or dependency change. See [T26 contract and validation evidence](35-product-form-long-text.md).

## Product and technical baseline

The application is a single-merchant storefront and administrator console for subscription and one-time digital services. The implemented order flow uses offline customer payment, administrator verification and manual fulfillment. Money is stored in integer CNY fen; timestamps are stored in UTC and displayed using the configured business timezone.

The repository uses Vue 3, TypeScript, Vite and Element Plus, with Node.js 24, Express, Prisma and MySQL 8.4. It remains a modular monolith. See [README](../README.md), [architecture](03-system-architecture.md) and the [production design](28-production-deployment-design.md) for the distinction between local development and the proposed server layout.

## Merged capabilities

| Area | Current implementation | Evidence and detailed contract |
| --- | --- | --- |
| Administrative foundations | Persisted authentication, customers/invitations, products, dynamic forms, settings and compatibility subscription management | [Authentication](12-authentication-customers-invitations.md), [products/settings](13-products-settings-forms.md), [Phase 2 subscriptions](14-user-subscription-core.md) |
| Order lifecycle | Read/create/edit/cancel, 24-hour timeout, manual payment verification, full-refund records and manual fulfillment; optimistic versions, immutable revisions and idempotent writes | [Order reads](16-order-read-api.md), [creation](19-order-creation-api.md), [edits](20-order-edit-api.md), [cancellation](21-order-cancellation-timeout.md), [payments](22-offline-payment-api.md), [refunds](23-offline-refund-api.md), [fulfillment](24-manual-fulfillment-api.md) |
| T20/T21 order centers | Real administrator order operations and customer-facing own-order list/detail/edit/cancel; later ADMIN self-service uses the same ownership boundary | [PR #29](https://github.com/lear111/ai-membership-store/pull/29), [PR #31](https://github.com/lear111/ai-membership-store/pull/31), [administrator center](25-admin-order-center.md), [customer center](26-customer-order-center.md) |
| T22 storefront ordering | Guest catalog/detail, protected purchase form after the buy action, login continuation, product-version guard, confirmation and idempotent submission into order history | [PR #33](https://github.com/lear111/ai-membership-store/pull/33), [#34](https://github.com/lear111/ai-membership-store/pull/34), [#35](https://github.com/lear111/ai-membership-store/pull/35), [#36](https://github.com/lear111/ai-membership-store/pull/36), [storefront contract](27-customer-storefront-and-order-placement.md) |
| T23.0 production design | Deployment design and historical Seoul VPS readiness audit are merged; runtime rollout is a separate status | [PR #37](https://github.com/lear111/ai-membership-store/pull/37), [production design](28-production-deployment-design.md) |
| T23.1 production application readiness | HTTPS profile, isolated credential contexts, explicit one-time ADMIN bootstrap and graceful API/worker drain | [PR #50](https://github.com/lear111/ai-membership-store/pull/50), [Clean Install guide](31-production-clean-install.md) |
| Customer subscription history | Paginated own-subscription list/detail with safe frozen fields and visible source-order links | [PR #38](https://github.com/lear111/ai-membership-store/pull/38), [API contract](05-api-contract.md) |
| Storefront administrator navigation | Console entry is shown only for ADMIN sessions, with session revalidation | [PR #39](https://github.com/lear111/ai-membership-store/pull/39), [interface specification](08-interface-specification.md) |
| T24.0 order numbers | New orders use nine-digit numbers with grouped display, raw copying and historical search compatibility; routes retain UUID identity | [PR #40](https://github.com/lear111/ai-membership-store/pull/40), [creation contract](19-order-creation-api.md) |
| T24.1 WeChat settings | Administrator upload/replacement/preview and enable/disable of the private collection QR; merchant remarks remain plain text | [PR #41](https://github.com/lear111/ai-membership-store/pull/41), [products/settings](13-products-settings-forms.md) |
| T24.2 payment claims | Eligible own-order QR reads and “I have paid” claims move UNPAID to PENDING_VERIFICATION; claims create no payment fact or entitlement | [PR #42](https://github.com/lear111/ai-membership-store/pull/42), [customer center](26-customer-order-center.md) |
| T24.4B.1 ADMIN storefront self-service | ACTIVE administrators can buy, claim payment, manage their own storefront orders and view their own subscriptions; source and audit actors remain server-derived ADMIN | [PR #43](https://github.com/lear111/ai-membership-store/pull/43), [API contract](05-api-contract.md) |
| T24.4B.2 self-registration | Email/password registration creates an ACTIVE CUSTOMER and Session; safe continuation returns the user to the purchase flow | [PR #44](https://github.com/lear111/ai-membership-store/pull/44), [API contract](05-api-contract.md) |
| T24.5A storefront design | Storefront navigation, visual tokens, catalog cards and desktop/mobile product detail layout | [PR #45](https://github.com/lear111/ai-membership-store/pull/45), [interface specification](08-interface-specification.md) |
| T24.5B product covers | One optional cover per product, administrator upload/replace/remove, normalized WebP storage, protected current-image reads, 4:3 display and a two-column mobile catalog | [PR #46](https://github.com/lear111/ai-membership-store/pull/46), [cover implementation and operation guide](29-product-cover-images.md) |
| T25 customer records and invitation registration | ADMIN creates label-only pending customer records; existing invite links register a customer-chosen email/password and atomically claim the original User ID, preserving orders/subscriptions | [PR #54](https://github.com/lear111/ai-membership-store/pull/54), [T25 contract and implementation evidence](34-customer-claim-registration.md) |
| Customer order detail polish | Redesigned offline payment section, prominent order number and merchant remarks, and safe HTTP/HTTPS links in product descriptions | [PR #49](https://github.com/lear111/ai-membership-store/pull/49) |
| T26 dynamic form long text | Textarea values/defaults up to 10,000 UTF-16 code units; 64 KiB UTF-8 schema/formData limits; 128 KiB JSON request limit; text/email limits unchanged | [PR #55](https://github.com/lear111/ai-membership-store/pull/55), [T26 contract](35-product-form-long-text.md) |

## Current boundaries and unfinished work

| Area | Boundary at this snapshot |
| --- | --- |
| Operating overview | The dashboard remains Mock. Real products, customers, settings, order centers and subscription reads must not be reverted to Mock. |
| Renewals | Customer/order-based renewal and SYSTEM_RENEWAL execution are not implemented services. The model includes renewal structures, and legacy ADMIN direct subscription renewal remains a compatibility API; neither means the order-renewal flow is complete. See [lifecycle design](17-order-creation-and-lifecycle-design.md) and [Phase 2 contract](14-user-subscription-core.md). |
| Payment providers | No provider checkout, payment webhook, automatic refund or money movement. The WeChat QR and customer claim support manual verification only. |
| Customer payment/refund evidence | No proof upload or customer refund-request workflow. Customer order responses do not expose administrator payment/refund attempt evidence. |
| Registration and email ownership | Ordinary and invitation registration are implemented. Email ownership remains unverified: invitation possession authorizes claiming the pre-created record but does not prove control of the mailbox. Duplicate-email behavior and the per-process connection-IP limiter retain their documented limits. |
| Email and supplier integration | No SMTP/outbox worker, supplier API, automatic supplier transfer or automated third-party activation. Planned supplier/customer email and expiry reminders remain future work. |
| Other planned APIs | Notification, verification-code and API-key APIs remain absent. |
| Production readiness | T23.0–T23.3 design/tooling are merged. The last reported production application release is T23.5-9 at `bd9b116`; PR #54's migration 15 and compatible application release are not evidenced as deployed. Verify the live host and complete a recoverable backup/restore checkpoint before separately approving the T25 production migration. |

## Migrations, storage and release evidence

- The current repository contains 15 additive migrations, including T25 `20261124000000_customer_invitation_registration` after the historical product-cover migration. Production must be explicitly verified and migrated to this chain before deploying the T25 application. Preserve all committed historical SQL and checksums.
- `WECHAT_QR_STORAGE_DIR` and `PRODUCT_COVER_STORAGE_DIR` must be separate, private persistent storage. Include the database and both image directories in coordinated backups. Superseded/unpublished image files are intentionally retained; use the maintenance procedures in the [WeChat settings guide](13-products-settings-forms.md) and [cover guide](29-product-cover-images.md) before cleanup.
- T25 migration 15 makes `User.loginEmail` and `Order.contactEmailSnapshot` nullable, adds an ACTIVE-credential CHECK and extends the OrderRevision V1 JSON whitelist only to permit a NULL contact snapshot. Its targeted cleanup affects only never-activated ADMIN-created CUSTOMER profiles. It does not prove any target database has been migrated.
- Test results in implementation reports belong to the runs recorded there. Do not treat an earlier commit's report as evidence that a later commit was rerun. A new validation report should identify the tested commit and commands, including the explicit database/E2E suite selectors where applicable.
- A successful merge is not evidence that a server is deployed, a database is migrated or production acceptance is complete. Record those operations and their verification separately when they are performed.

## Maintaining this index

After an implementation merges, update the verified snapshot and affected capability/boundary rows, then reconcile the roadmap and relevant contract status notes. Preserve historical decisions and test records with their original scope. Select the next task from the owner's current request and verified outstanding work; a historical “not started” statement is not sufficient to select or repeat a task.
