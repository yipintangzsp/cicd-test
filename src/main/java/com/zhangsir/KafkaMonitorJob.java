package com.devops;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

public class KafkaMonitorJob {
    public static void main(String[] args) throws Exception {
        // 1. 初始化 Flink 执行环境
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // ==========================================
        // 🎯 核心魔法：开启 Checkpoint (检查点)！
        // 就是这两行代码，能让 Grafana 里那几个 "No data" 的面板瞬间拉满数据！
        // ==========================================
        env.enableCheckpointing(5000); // 每 5000 毫秒（5秒）做一次状态快照
        env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
        env.getCheckpointConfig().setCheckpointTimeout(60000);

        // 2. 配置 Kafka 数据源
        KafkaSource<String> source = KafkaSource.<String>builder()
                // ⚠️ 记得把这里换成你 K8s 集群里真实的 Kafka 地址和端口
                .setBootstrapServers("10.42.0.210:9092") 
                .setTopics("system-logs") // 监听的 Topic
                .setGroupId("flink-devops-group") // 消费组 ID
                .setStartingOffsets(OffsetsInitializer.latest()) // 从最新数据开始读
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();

        // 3. 构建数据流DAG：读取 -> 简单转换 -> 打印输出
        env.fromSource(source, WatermarkStrategy.noWatermarks(), "Kafka Source")
           .map(message -> {
               // 这里可以写你真实的数据清洗逻辑，现在先随便拼接一下
               return "[DevOps 监控捕获] 收到 Kafka 消息: " + message;
           })
           .print(); // 直接打印到 TaskManager 的日志里

        // 4. 触发执行 (这行代码是发动机的点火开关)
        env.execute("Flink-Kafka-Checkpoint-Job");
    }
}