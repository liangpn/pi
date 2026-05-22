# table_plan.steps 设计说明

## 目标

`table_plan.steps` 保存一个计划的执行编排和输出契约。

它解决三件事：

- 定义执行顺序：外层 step 串行执行。
- 定义并发任务：每个 step 内的 tasks 并行执行。
- 定义卡片输出契约：task 可选配置 `card_type` 和 `data_structure`，用于约束 agent 的结构化返回，并指导前端渲染。

`steps` 是计划定义，不保存运行状态、执行结果、日志、进程信息或卡片实际数据。

## MySQL 字段建议

`table_plan` 表中增加或保留一个 `steps` 字段：

```sql
steps JSON NOT NULL
```

不建议使用 `varchar`：

- `steps` 是嵌套结构，长度不可控。
- MySQL `JSON` 类型会校验合法 JSON。
- 后续可以通过 `JSON_EXTRACT` 查询，也可以为关键字段增加 generated column。

如果业务允许空计划，可以使用：

```sql
steps JSON NULL
```

但接口层仍建议把空值规范化为 `[]`。

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
        "mcp": [],
        "skills": [],
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

## 字段含义

### Step

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 步骤 id。由管理端前端创建或后端补齐，在同一 plan 内唯一。 |
| `title` | string | 是 | 步骤标题。 |
| `tasks` | array | 是 | 当前 step 下的任务列表。同一 step 内的 task 可并行执行。 |

### Task

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 任务 id。由管理端前端创建或后端补齐，在同一 plan 内唯一。 |
| `title` | string | 是 | 任务标题，也可作为卡片标题。 |
| `description` | string | 是 | 给 agent 的业务执行说明。 |
| `mcp` | array | 否 | task 可用或期望使用的 MCP/tool 声明。第一版可以先保存配置。 |
| `skills` | array | 否 | task 可用或期望使用的技能声明。第一版可以先保存配置。 |
| `card_type` | string | 否 | 卡片类型。为空时任务只返回文本总结，不渲染业务卡片。 |
| `data_structure` | array | 条件必填 | `card_type` 非空时必填，定义 `card_data` 的结构。 |

### DataField

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `field` | string | 是 | 字段名。注意不是 `filed`。 |
| `type` | string | 是 | 字段类型：`string`、`number`、`boolean`、`array`、`object`。 |
| `required` | boolean | 否 | 是否必填，默认可按 `false` 处理。 |
| `description` | string | 否 | 字段说明，用于 prompt 和管理端展示。 |
| `items` | object | 条件必填 | `type=array` 时建议填写，描述数组元素类型。 |
| `fields` | array | 条件必填 | `type=object` 时建议填写，描述对象字段。 |

## card_type 建议取值

第一版建议使用：

```text
text
table
map
media
json
```

其中：

- `media`：媒体/视频类卡片。后端返回业务引用数据，例如 `gbids`，不返回视频流 bytes。
- `map`：地图/点位类卡片。
- `table`：表格类卡片。
- `text`：文本摘要类卡片。
- `json`：调试或结构化预览卡片。

## 约束规则

- `steps` 外层数组顺序就是执行顺序。
- step 内 `tasks` 数组顺序只用于展示排序，不代表串行执行。
- step 之间串行：上一个 step 完成后，才进入下一个 step。
- task 是最小执行单元：每个 task 对应一个子 agent 执行。
- `card_type` 为空时，不应填写 `data_structure`。
- `card_type` 非空时，必须填写 `data_structure`。
- `data_structure` 约束 agent 返回的 `card_data`，也约束前端渲染所需数据。
- `steps` 不存 run 状态、task 状态、agent run id、日志、错误、结果或卡片实际数据。

## Agent 返回结构

task 执行完成后，agent 只返回当前 task 的结果。

无卡片：

```json
{
  "content": "任务完成之后的一段总结"
}
```

有卡片：

```json
{
  "content": "任务完成之后的一段总结",
  "card_data": {
    "gbids": ["gbid_1", "gbid_2"]
  }
}
```

`title` 和 `card_type` 不要求 agent 返回。后端根据 task 配置补齐：

```json
{
  "title": "任务标题",
  "type": "media",
  "data": {
    "gbids": ["gbid_1", "gbid_2"]
  }
}
```

## 管理端接口建议

管理端 CRUD 可以直接读写 `table_plan.steps`，但后端应做结构校验：

- `steps` 必须是数组。
- 每个 step 必须有 `id`、`title`、`tasks`。
- 每个 task 必须有 `id`、`title`、`description`。
- 同一 plan 内 step id 唯一。
- 同一 plan 内 task id 唯一。
- `card_type` 为空时忽略或拒绝 `data_structure`。
- `card_type` 非空时校验 `data_structure`。
- `field`、`type` 必须合法。

管理端不需要关心 POC 的运行态结构。运行态由执行服务在启动 run 时从 `steps` 克隆生成。
