# 成员邀请（申请 → 审批 → 自动邀请）

## 申请

申请人打开组织仓库的 Issue 表单：

https://github.com/omdsh-dev/.github/issues/new?template=join-request.yml

填写 GitHub ID 和申请理由。Issue 的**作者**就是被邀请人，表单里的 GitHub ID 只用于人工核对，不会作为邀请对象。

## 审批

组织 Owner（对 `omdsh-dev/.github` 有 Admin 权限的人）给 Issue 加 `approved` 标签。

- 只有对 `.github` 仓库有 **Admin** 权限的账号才能触发邀请；普通 write 权限不够。
- 审批人必须是加标签的人（`sender`），不是申请人。
- 不想通过就关掉 Issue，不加标签。

## 自动处理

`Member invite` workflow 在 `approved` 标签被加上时运行：

1. 校验 Issue 仍打开、带 `approved` 标签、作者 = 被邀请人；
2. 校验加标签的人对 `omdsh-dev/.github` 有 Admin 权限；
3. 已经是成员 → 评论说明并关闭；
4. 否则调用组织邀请 API，角色固定为 `member`（不是 Owner），评论邀请结果并关闭 Issue。

workflow 使用仓库 secret `OMDSH_ADMIN_TOKEN`（需要 `admin:org`）。

## 手动补邀

`Member invite` workflow 支持手动触发：

- `login`：要邀请的账号
- `mode`：先 `dry-run` 检查，再 `apply`

## 安全边界

- 邀请对象只来自 Issue 作者，不能通过表单字段指定别人；
- 审批人必须是仓库 Admin；
- 角色固定 `member`，不会授予 Owner；
- 不读取、不存储申请人的额外个人信息。
