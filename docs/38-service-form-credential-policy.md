# 服务表单凭据限制移除决策

- Document: SERVICE-FORM-CREDENTIAL-POLICY
- Status: 已实施（代码与单元测试），未部署
- Date: 2026-11-27
- Related: [商品与表单](13-products-settings-forms.md)、[下单 API](19-order-creation-api.md)、[安全与运维](06-security-and-operations.md)、[客户订单中心](26-customer-order-center.md)

## 决策

店主决定移除“普通服务表单不得收集密码、验证码、恢复码、会话令牌、API Key 等认证凭证”的全部限制。商品动态表单现在可以配置任意字段，下单、编辑、后台创建/编辑与订单详情展示均按普通文本处理这些值。

此前该限制由 `backend/src/contracts/credential-fields.ts` 的正则匹配实现，并在下单、购买页、订单 DTO、设置、前端校验与订单详情中重复调用。它导致供应商要求填写密码类信息的商品“能保存表单但不能购买”，因此整体删除。

## 行为变化

- 商品表单创建/编辑、购买页读取、下单、客户编辑、后台创建/编辑订单均不再因字段 id、label、hint 或值的文本命中而拒绝或清空数据。
- 仅保留结构校验：表单 schema 或 formData 格式无效时，购买页仍返回 409 `PRODUCT_FORM_UNAVAILABLE`，订单详情仍隐藏无效的冻结表单。
- 删除 `backend/src/contracts/credential-fields.ts`；同步删除服务端、前端、单元测试、集成测试与 e2e 中的相关断言和提示文案。

## 安全说明（重要）

- `Order.formData` 与 `OrderRevision` 快照按原样明文存储，数据库、备份与后台订单详情都会出现这些值。本次变更没有增加字段级加密、脱敏或访问审计。
- 因此只应在确认供应商流程确实需要时填写；不要把与订单无关的第三方账号密码、支付卡信息或生产密钥写入表单。
- 如后续需要“可收集但加密存储/按需展示”，应单独设计密钥管理、脱敏展示与审计，而不是恢复正则拦截。

## 验证

- `npm run typecheck -w backend`、`npm run typecheck -w frontend`、`npm run lint` 通过。
- `npm run test -w backend` 93 个测试通过；`npm run test -w frontend` 52 个测试通过。
- 需要 MySQL/Docker 的 `backend/test/integration/*` 与 Playwright e2e 未在本机执行，已按新契约改写，需在具备环境时复跑。
- 本次未执行数据库迁移；表结构未变。

## 文档收敛

[06-security-and-operations.md](06-security-and-operations.md) 第 1 节已按本决策改写，[AGENTS.md](../AGENTS.md) 与 [README](../README.md) 的范围描述已同步。其余文档（05、08、13、17、18、19、25、26、27、35 及 00 边界表）仍保留旧口径，按仓库约定由 ChatGPT 维护，后续统一收敛；历史报告保持原始范围不回改。
