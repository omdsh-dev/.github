# 仓库迁移与新成员权限（自动管线）

## 目标

成员把仓库迁移进 `omdsh-dev` 后，自动获得**该仓库**的 Admin 权限，不需要组织 Owner 逐个仓库授权。

管线只把权限授予**仓库转移前的所有者**，不使用“贡献排行”或“最近提交人”推断，避免把 Admin 误发给无关贡献者。

## 组成

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/repository-onboarding.yml` | 每 10 分钟运行一次，也支持手动触发 |
| `scripts/repository-onboarding.mjs` | 邀请成员、维护仓库快照、检测迁移、授予权限、写入登记表 |
| `governance/onboarding-queue.json` | 观察名单与每个成员的仓库快照（node_id） |
| `governance/repository-maintainers.json` | 权限登记表，日常 enforcement 仍以此为准 |

## 工作方式

1. 触发时，把 `users` 中的账号邀请进组织（若还不是成员），并记录其名下的公开仓库快照（`node_id` 为唯一键）。
2. 之后每次运行重新扫描观察名单中成员的仓库。
3. 如果某个 `node_id` 从成员名下消失，同时出现在 `omdsh-dev` 的仓库列表中，说明该成员把仓库迁移进了组织：
   - 给该成员授予该仓库的 `admin`；
   - 若登记表里没有该仓库，自动登记该成员为维护者；
   - 记录到 `onboarding-queue.json` 的 `granted` 中，便于审计。
4. 其他情况（删除、改名、迁移到别处）不会授权。

`node_id` 在仓库改名、转移后保持不变，因此改名后迁移也能匹配。授权对象只能是转移前拥有该 `node_id` 的账号。

## 使用

首次或批量拉人（手动触发）：

```text
users: Nwflower, Fisfzy
mode:  apply
```

立即给某人某个仓库授权（补录）：

```text
repo: dsh-example
user: Nwflower
mode: apply
```

只审计不修改：

```text
mode: dry-run
```

## 限制与约定

- 只观察**公开仓库**。私有仓库迁移不会自动发现，需要用上面的“立即授权”补录。
- 成员把仓库迁移进组织前，必须先接受组织邀请；管线会先邀请，再等待其迁移。
- 观察期为 180 天；超期后可重新加入名单。
- 如果仓库在登记表中已属于其他人，管线不会覆盖，只在运行摘要中报告冲突。
- 组织 Owner 的 Admin 权限来自 Owner 身份，不需要也不能通过此管线授予。
- 组织基础权限保持 `none`，此管线只做**单仓库**授权，不扩大全组织权限。

## 为什么不用 GitHub 原生能力

- 组织基础权限（base permission）只能全组织生效，无法只给“迁移者”一个仓库。
- 免费版组织没有 Audit Log API，无法事后查询“谁执行了 `repo.transfer`”。
- 仓库 Webhook 的 `repository.transferred` 需要常驻服务接收；本管线用定时扫描 + `node_id` 归属证明达到同样效果，不增加托管服务。
