package org.apache.flink.streaming.api.lineage;

import java.io.Serializable;

/**
 * Minimal compatibility type required by flink-connector-kafka 4.0.1-2.0 when the runtime Flink
 * cluster is still on 1.18.x.
 */
public interface LineageVertex extends Serializable {
}
