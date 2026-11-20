# 仓库迁移与新成员权限（Webhook）

## 目标

成员把仓库迁移进 `omdsh-dev` 后，自动获得**该仓库**的 Admin 权限，组织角色保持 `member`。

授权对象只能是**仓库转移前的所有者**；不使用贡献排行或“最近提交人”推断。

## 触发链路

1. GitHub 在仓库转移完成时，向组织 Webhook 发送 `repository` 事件，`action = transferred`。
2. Cloudflare Worker `omdsh-transfer-hook` 校验 `X-Hub-Signature-256`，确认仓库属于 `omdsh-dev`。
3. Worker 调用 GitHub API，触发 `.github` 仓库的 `Repository onboarding` workflow，传入：
   - `repo`：仓库名
   - `user`：`payload.sender.login`（执行转移的人）
   - `node_id`：`payload.repository.node_id`（仓库唯一 ID，改名/转移不变）
4. Workflow 再次读取 `/repos/omdsh-dev/<repo>`，只有 `node_id` 与 payload 一致时才给 `user` 授予该仓库的 `admin`。
5. Workflow 把仓库登记进 `governance/repository-maintainers.json`（公开的治理登记表）。

## 为什么不会给错人

- Webhook 的 `sender` 是 GitHub 记录的、实际执行转移的账号。
- `node_id` 是全局唯一且不随仓库改名/转移变化的标识；伪造的 dispatch 无法用别的仓库的 `node_id` 通过校验。
- 只授予**单个仓库**的 Admin，不改变组织角色，也不碰其他仓库。

## 数据与隐私

- 该链路**不保存**任何成员仓库快照或观察名单。
- Worker 只把 `repo`、`user`、`node_id` 传给 workflow，不读取仓库内容、不读取私有仓库。
- 公开仓库的登记信息写在公开的 `repository-maintainers.json` 里，这是治理需要，且不包含 token 或个人信息。

## 手动操作

- 邀请成员：`workflow_dispatch`，`users: alice, bob`。
- 补录授权（例如私有仓库迁移未被 Webhook 覆盖）：`repo` + `user`。
- 只审计：`mode: dry-run`。

## 依赖

- 组织 Webhook：`repository` 事件，指向 Worker URL，使用共享 secret。
- Worker secret：`GITHUB_TOKEN`（只需触发 workflow 的权限）、`WEBHOOK_SECRET`。
- 仓库 secret：`OMDSH_ADMIN_TOKEN`（仓库协作者管理 + 邀请成员）。
