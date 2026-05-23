[
    {
        "id": "step_incident_facts",
        "title": "警情要素识别",
        "tasks": [
            {
                "id": "task_load_dispatch_resources",
                "title": "提取出警设备和人员",
                "description": "从警情详情中提取出警设备和人员；如果当前警情详情缺少出警设备列表，则调用 @jcj-get-case-detail@ 查询出警设备和人员信息。",
                "tools": [
                    "jcj-get-case-detail"
                ],
                "skills": []
            }
        ]
    },
    {
        "id": "step_basic_assessment",
        "title": "基础研判",
        "tasks": [
            {
                "id": "task_lookup_address_by_incident_address",
                "title": "根据事发地址检索地点",
                "description": "根据警情详情中的事发地址调用 @panel-operate@ 检索地点位置。",
                "tools": [
                    "panel-operate"
                ],
                "skills": [],
                "card_type": "map",
                "data_structure": [
                    {
                        "field": "address",
                        "type": "string",
                        "required": true,
                        "description": "用于地图展示的事发地址"
                    }
                ]
            },
            {
                "id": "task_lookup_address_by_coordinate",
                "title": "根据经纬度定位地点",
                "description": "根据警情详情中的经纬度生成地图定位结果；当前项目没有独立的坐标反查地点 MCP，前端基于坐标渲染地图卡片。",
                "tools": [],
                "skills": [],
                "card_type": "map",
                "data_structure": [
                    {
                        "field": "coordinate",
                        "type": "string",
                        "required": true,
                        "description": "经纬度坐标，格式为 经度,纬度"
                    }
                ]
            },
            {
                "id": "task_check_caller_background",
                "title": "查询报警人背景",
                "description": "根据警情详情中的报警电话调用 @background-check@ 查询报警人姓名和人员标签。",
                "tools": [
                    "background-check"
                ],
                "skills": [],
                "card_type": "text",
                "data_structure": [
                    {
                        "field": "name",
                        "type": "string",
                        "required": false,
                        "description": "报警人姓名"
                    },
                    {
                        "field": "labels",
                        "type": "array",
                        "required": false,
                        "description": "报警人标签列表",
                        "items": {
                            "type": "string"
                        }
                    }
                ]
            },
            {
                "id": "task_query_disposal_plan",
                "title": "查询处置预案",
                "description": "根据警情详情中的接警单编号调用 @getPrettyPlanInstance@ 查询当前警情处置预案。",
                "tools": [
                    "getPrettyPlanInstance"
                ],
                "skills": [],
                "card_type": "text",
                "data_structure": [
                    {
                        "field": "plan_description",
                        "type": "array",
                        "required": false,
                        "description": "处置预案内容",
                        "items": {
                            "type": "string"
                        }
                    }
                ]
            },
            {
                "id": "task_open_police_resources_panel",
                "title": "打开可调资源面板",
                "description": "根据警情详情中的接警单编号调用 @panel-operate@ 打开当前警情可调资源面板。",
                "tools": [
                    "panel-operate"
                ],
                "skills": [],
                "card_type": "text",
                "data_structure": [
                    {
                        "field": "panel_type",
                        "type": "string",
                        "required": true,
                        "description": "面板类型，固定为 police-resources"
                    },
                    {
                        "field": "success",
                        "type": "boolean",
                        "required": true,
                        "description": "可调资源面板是否打开成功"
                    }
                ]
            }
        ]
    },
    {
        "id": "step_scene_situation",
        "title": "现场态势展开",
        "tasks": [
            {
                "id": "task_open_nearby_surveillance",
                "title": "打开事发地周边监控",
                "description": "根据警情详情中的经纬度或事发地址调用 @device-operate@ 打开周边监控，并输出前端媒体卡片需要的监控设备 GBID 列表。",
                "tools": [
                    "device-operate"
                ],
                "skills": [],
                "card_type": "media",
                "data_structure": [
                    {
                        "field": "gbids",
                        "type": "array",
                        "required": true,
                        "description": "周边监控设备 GBID 列表",
                        "items": {
                            "type": "string"
                        }
                    }
                ]
            },
            {
                "id": "task_open_nearby_police",
                "title": "打开事发地周边警力",
                "description": "根据警情详情中的经纬度或事发地址调用 @device-operate@ 打开周边警力。",
                "tools": [
                    "device-operate"
                ],
                "skills": [],
                "card_type": "map",
                "data_structure": [
                    {
                        "field": "coordinate",
                        "type": "string",
                        "required": false,
                        "description": "打开周边警力使用的经纬度坐标"
                    },
                    {
                        "field": "address",
                        "type": "string",
                        "required": false,
                        "description": "打开周边警力使用的事发地址"
                    },
                    {
                        "field": "radius",
                        "type": "integer",
                        "required": false,
                        "description": "周边半径，单位米"
                    }
                ]
            }
        ]
    },
    {
        "id": "step_dispatch_resource_visualization",
        "title": "出警资源可视化",
        "tasks": [
            {
                "id": "task_play_dispatch_bwc",
                "title": "调阅出警民警单兵或执法仪",
                "description": "从警情出警设备中筛选单兵或执法仪设备；如果设备信息缺失，先调用 @jcj-get-case-detail@ 查询出警设备，再调用 @device-operate@ 打开设备画面。",
                "tools": [
                    "jcj-get-case-detail",
                    "device-operate"
                ],
                "skills": [],
                "card_type": "media",
                "data_structure": [
                    {
                        "field": "gbids",
                        "type": "array",
                        "required": true,
                        "description": "单兵或执法仪设备 GBID 列表",
                        "items": {
                            "type": "string"
                        }
                    }
                ]
            },
            {
                "id": "task_track_dispatch_police_car",
                "title": "跟踪出警警车",
                "description": "从警情出警设备中筛选警车设备；如果设备信息缺失，先调用 @jcj-get-case-detail@ 查询出警设备，再调用 @device-operate@ 开始跟踪出警警车。",
                "tools": [
                    "jcj-get-case-detail",
                    "device-operate"
                ],
                "skills": [],
                "card_type": "media",
                "data_structure": [
                    {
                        "field": "gbids",
                        "type": "array",
                        "required": true,
                        "description": "警车设备 GBID 列表",
                        "items": {
                            "type": "string"
                        }
                    }
                ]
            }
        ]
    }
]