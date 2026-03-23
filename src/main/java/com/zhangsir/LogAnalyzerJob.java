package com.zhangsir; // 1. 必须放在第一行

// 2. 所有的 import 都紧随其后
import org.apache.flink.api.common.eventtime.WatermarkStrategy; 
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

// 3. 最后才是类定义
public class LogAnalyzerJob {

    public static void main(String[] args) throws Exception {
        final StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // 配置 Kafka 数据源
        KafkaSource<String> source = KafkaSource.<String>builder()
                .setBootstrapServers("kafka-0.kafka-headless.ns-bigdata.svc.cluster.local:9092")
                .setTopics("system-logs") 
                .setGroupId("flink-devops-group")
                .setStartingOffsets(OffsetsInitializer.latest()) 
                .setValueOnlyDeserializer(new SimpleStringSchema()) 
                .build();

        // 核心步骤：使用 WatermarkStrategy
        DataStream<String> kafkaStream = env.fromSource(source, WatermarkStrategy.noWatermarks(), "Kafka Source");

        // 简单处理：将日志转大写
        DataStream<String> processedStream = kafkaStream.map(log -> "[实时审计] " + log.toUpperCase());

        processedStream.print();

        env.execute("ZhangSir-Log-Analyzer");
    }
}