# table_plan.steps 数据结构参考

## 定位

`table_plan.steps` 保存计划的执行编排和 task 输出契约。运行规则、状态机和验收标准以 `docs/superpowers/specs/spec-pi-task-console.md` 为准。

`steps` 是计划定义，不保存运行状态、执行结果、日志、进程信息或卡片实例。

## MySQL 字段

`table_plan` 表使用 JSON 字段保存 `steps`：

```sql
steps JSON NOT NULL
```

`steps` 为空计划时使用空数组 `[]`。

## JSON 结构

```json
[
  {
    "id": "step_xxx",
    "title": "步骤标题",
    "tasks": [
      {
        "id": "task_xxx",
        "title": "任务标题",
        "description": "任务描述",
        "tools": ["device-operate"],
        "skills": [],
        "retry": {
          "max_attempts": 2,
          "base_delay_ms": 1000,
          "max_tool_calls": 8,
          "retry_on": ["process_error", "validation_error"]
        },
        "card_type": "media",
        "data_structure": [
          {
            "field": "gbids",
            "type": "array",
            "required": true,
            "description": "视频设备 GBID 列表",
            "items": {
              "type": "string"
            }
          }
        ]
      }
    ]
  }
]
```

## Step 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 步骤 id。同一 plan 内唯一。 |
| `title` | string | 是 | 步骤标题。 |
| `tasks` | array | 是 | 当前 step 下的 task 列表。 |

## Task 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | Task id。同一 plan 内唯一。 |
| `title` | string | 是 | Task 标题，也是默认卡片标题。 |
| `description` | string | 是 | 给 child agent 的业务执行说明。 |
| `tools` | string[] | 否 | 当前 task 可用的业务工具/MCP 工具 allowlist。 |
| `skills` | string[] | 否 | 当前 task 启用的技能列表。 |
| `retry` | object | 否 | Task 级重试覆盖配置。缺省字段使用 runtime 默认配置。 |
| `card_type` | string | 否 | 卡片类型。缺省表示该 task 不创建业务卡片。 |
| `data_structure` | array | 条件必填 | `card_type` 有值时必填，用于校验 agent 输出的 `data`。 |

## DataField 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `field` | string | 是 | 字段名。 |
| `type` | string | 是 | 字段类型：`string`、`number`、`integer`、`boolean`、`array`、`object`。 |
| `required` | boolean | 否 | 是否必填。缺省按 `false` 处理。 |
| `description` | string | 否 | 字段说明，用于 prompt 和管理端展示。 |
| `items` | object | 条件必填 | `type=array` 时必填，描述数组元素类型。 |
| `fields` | array | 条件必填 | `type=object` 时必填，描述对象字段。 |

## Retry 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `max_attempts` | integer | 否 | 最大 attempt 次数。`1` 表示不做 task retry。 |
| `base_delay_ms` | integer | 否 | Task retry 基础等待时间，单位毫秒。 |
| `max_tool_calls` | integer | 否 | 单个 attempt 允许的最大工具调用次数。 |
| `retry_on` | string[] | 否 | 允许触发 task retry 的失败原因列表。空数组表示不 retry。 |

## card_type 取值

第一版支持：

```text
text
table
map
media
json
```

含义：

- `text`：文本摘要或结构化文本字段。
- `table`：表格数据。
- `map`：地址、坐标、marker 或地图操作结果。
- `media`：媒体/视频引用数据，例如 GBID。后端不返回视频 bytes。
- `json`：调试或通用结构化预览。

## 约束规则

- `steps` 外层数组顺序就是 step 执行顺序。
- step 内 `tasks` 数组顺序只用于展示排序，不代表串行执行。
- step 之间串行执行。
- 当前 step 内 tasks 独立并行执行，实际并发量受 runtime 配置控制。
- 每个 task 对应一个独立 child Pi RPC agent attempt。
- `tools` 缺省或为空数组时，该 task 不启用业务工具/MCP 工具。
- `skills` 缺省或为空数组时，该 task 不启用额外技能。
- `card_type` 只能缺省或取支持列表中的值。
- `card_type` 不能使用空字符串。
- `card_type` 有值时，`data_structure` 必须存在且不能为空数组。
- `card_type` 缺省时，`data_structure` 必须缺省或为空数组。
- `data_structure` 约束 agent 输出的 `data`，也约束前端 card renderer 所需数据。
- `steps` 不存 run 状态、task 状态、agent run id、日志、错误、结果或卡片实例。

## Agent 返回结构

Task 执行完成后，agent 只返回当前 task 的结果。

无卡片：

```json
{
  "content": "任务完成之后的一段总结"
}
```

有卡片数据：

```json
{
  "content": "任务完成之后的一段总结",
  "data": {
    "gbids": ["gbid_1", "gbid_2"]
  }
}
```

Agent 不返回 card title、card type 或完整 card 对象。后端根据 task 配置组装 card：

```json
{
  "title": "任务标题",
  "type": "media",
  "data": {
    "gbids": ["gbid_1", "gbid_2"]
  }
}
```

## 管理端校验

管理端 CRUD 可以读写 `table_plan.steps`，后端必须在保存或启动 run 前校验：

- `steps` 是数组。
- 每个 step 有 `id`、`title`、`tasks`。
- 每个 task 有 `id`、`title`、`description`。
- 同一 plan 内 step id 唯一。
- 同一 plan 内 task id 唯一。
- `tools` 和 `skills` 是字符串数组。
- `retry` 字段值满足 runtime retry 约束。
- `card_type` 缺省或合法。
- `data_structure` 与 `card_type` 的条件关系合法。
- `field` 和 `type` 合法。

运行态由执行服务在启动 run 时从 `steps` 克隆生成。
