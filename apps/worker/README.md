# worker

职责：

- 运行日终总结归档任务
- 汇总当天 conversation turns
- 生成当天日记摘要
- 抽取并归并情绪日志、成长记录和家庭事件
- 更新知识图谱、趋势统计和因果线索
- 后续再承接音频、图片、视频等长耗时任务

第一批任务建议：

- `daily.archive`
- `memory.normalize`
- `causal.discover`
- `graph.refresh`

暂不绑定外部队列。先用进程内命令、定时任务或手动脚本跑通闭环；等重试和并发需求明确后再引入队列。
