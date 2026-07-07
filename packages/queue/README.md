# queue

预留给后续任务调度。

第一阶段不引入外部队列。日终归档、图谱刷新和因果发现先用脚本或进程内定时任务实现，状态写入 SQLite。

只有当归档、多模态处理或批量重算需要可靠重试和并发控制时，再在这里放 job topic、publisher、worker registration 和幂等辅助逻辑。
