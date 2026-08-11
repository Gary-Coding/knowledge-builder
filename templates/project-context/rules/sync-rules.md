# 持续回写规则

出现以下变化时必须更新知识资产：

- 新增或删除 Controller、Job、Consumer、FeignClient。
- 修改核心表、核心字段、状态枚举、MQ topic 或消息体。
- 修改业务流程、状态机、幂等、补偿或外部系统同步口径。
- 新增业务概念、能力、规则，或调整业务域边界。

需求完成后依次检查 `glossary → concepts → capabilities → rules → graph → mappings`，更新关联仓库 commit，并重新执行完整性校验。
